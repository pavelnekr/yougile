import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { z } from "zod";
import { config } from "../../config.js";
import { requireWorkspaceAccess } from "../auth/service.js";
import { recordLog } from "../logs/service.js";
import { getDapsDatabase, getDapsSchemas, quoteDapsSchema } from "./database.js";
import { getNetboxApiSettings } from "./netbox.js";
import { buildSiteGeneratorPlan, parseSiteGeneratorFiles, type SiteGeneratorPlan } from "./site-generator.js";

const kpiFields = ["KPI-01", "KPI-02", "KPI-03", "KPI-04", "KPI-05", "KPI-06", "KPI-07"] as const;
const dailyKpiSaveSchema = z.object({
  k0Fact: z.number().finite(),
  k0Accum: z.number().finite(),
  k3Accum: z.number().finite()
});
const netboxExportSchema = z.object({
  siteSlug: z.string().trim().min(1).max(100),
  rows: z.array(z.object({
    tspuId: z.string().max(100),
    host: z.string().max(200),
    port: z.string().max(200),
    linkUpdatedAt: z.string().max(100),
    bypassHost: z.string().max(200),
    bypassPort: z.string().max(200),
    behindDevice: z.string().max(200).optional(),
    behindPort: z.string().max(200).optional(),
    linkCapacity: z.string().max(200).optional()
  })).min(1).max(20_000)
});

const netboxLookupProgress = new Map<string, { slug: string; phase: string; percent: number; interfaces: unknown[]; done: boolean; error?: string; updatedAt: number }>();
const siteGeneratorPreviews = new Map<string, { ownerId: string; siteSlug: string; siteId: number; plan: SiteGeneratorPlan; expiresAt: number }>();
const siteGeneratorActiveSites = new Set<number>();
const siteGeneratorActiveTypeModels = new Set<string>();

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

type NetboxCollectionResponse<T> = { results?: T[]; next?: string | null };

async function fetchNetboxCollection<T>(initialUrl: URL, headers: Record<string, string>): Promise<T[]> {
  const results: T[] = [];
  let nextUrl: URL | null = initialUrl;
  while (nextUrl) {
    const response = await fetch(nextUrl, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Не удалось прочитать объекты площадки из NetBox.");
    const page = await response.json() as NetboxCollectionResponse<T>;
    results.push(...(page.results ?? []));
    if (!page.next) nextUrl = null;
    else {
      const candidate = new URL(page.next, initialUrl);
      if (candidate.origin !== initialUrl.origin) throw new Error("NetBox вернул ссылку на другую площадку API.");
      nextUrl = candidate;
    }
  }
  return results;
}

type NetboxSiteSummary = { id: number; name: string; slug: string };
type NetboxSiteInventory = { devices: { id: number; name?: string }[]; racks: { id: number; name?: string }[]; cables: { id: number; label?: string }[] };

async function findNetboxSite(apiBase: URL, slug: string, headers: Record<string, string>): Promise<NetboxSiteSummary | undefined> {
  const url = new URL("sites/", apiBase);
  url.searchParams.set("slug", slug);
  return (await fetchNetboxCollection<NetboxSiteSummary>(url, headers)).find((site) => site.slug === slug);
}

async function getNetboxSiteInventory(apiBase: URL, siteId: number, headers: Record<string, string>): Promise<NetboxSiteInventory> {
  const collection = (path: string) => {
    const url = new URL(`${path}/`, apiBase);
    url.searchParams.set("site_id", String(siteId));
    url.searchParams.set("limit", "1000");
    return url;
  };
  const [devices, racks, cables] = await Promise.all([
    fetchNetboxCollection<NetboxSiteInventory["devices"][number]>(collection("devices"), headers),
    fetchNetboxCollection<NetboxSiteInventory["racks"][number]>(collection("racks"), headers),
    fetchNetboxCollection<NetboxSiteInventory["cables"][number]>(collection("cables"), headers)
  ]);
  return { devices, racks, cables };
}

export async function registerDapsRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const readAccess = requireWorkspaceAccess("DAPS");
  const writeAccess = requireWorkspaceAccess("DAPS", true);

  const netboxSiteDeviceCount = async (apiBase: URL, siteId: number, headers: Record<string, string>) => {
    const devicesUrl = new URL("devices/", apiBase);
    devicesUrl.searchParams.set("site_id", String(siteId));
    devicesUrl.searchParams.set("limit", "1");
    const response = await fetch(devicesUrl, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Не удалось проверить устройства площадки в NetBox.");
    const data = await response.json() as { count?: number; results?: unknown[] };
    return data.count ?? data.results?.length ?? 0;
  };

  app.get<{ Querystring: { slug?: string } }>("/api/daps/netbox/site/generator/check", { preHandler: readAccess }, async (request, reply) => {
    const slug = z.string().trim().min(1).max(100).safeParse(request.query.slug);
    if (!slug.success) return reply.code(400).send({ error: "Введите номер площадки." });
    const settings = await getNetboxApiSettings(prisma);
    if (!settings.tokenConfigured) return reply.code(503).send({ error: "Для NetBox не настроен API-токен. Обратитесь к администратору." });
    const apiBase = new URL("/api/dcim/", settings.url);
    const headers = { Authorization: `${settings.tokenType} ${settings.token}`, Accept: "application/json" };
    try {
      const site = await findNetboxSite(apiBase, slug.data, headers);
      if (!site) return { found: false };
      const deviceCount = await netboxSiteDeviceCount(apiBase, site.id, headers);
      return { found: true, site, deviceCount, empty: deviceCount === 0 };
    } catch (error) {
      request.log.warn({ err: error, siteSlug: slug.data }, "Could not check NetBox site for site generation");
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Не удалось проверить площадку в NetBox." });
    }
  });

  app.post<{ Querystring: { slug?: string } }>("/api/daps/netbox/site/generator/preview", { preHandler: writeAccess }, async (request, reply) => {
    const slug = z.string().trim().min(1).max(100).safeParse(request.query.slug);
    if (!slug.success) return reply.code(400).send({ error: "Введите номер площадки." });
    if (!request.isMultipart()) return reply.code(406).send({ error: "Загрузите два файла XLSX: спецификацию и фасады." });
    const uploaded = new Map<string, Buffer>();
    const filenames = new Map<string, string>();
    try {
      for await (const part of request.parts({ limits: { files: 2, fields: 0, parts: 2, fileSize: config.UPLOAD_MAX_BYTES } })) {
        if (part.type !== "file") continue;
        const filename = part.filename.split(/[\\/]/).pop() ?? "";
        if (!filename.toLocaleLowerCase("en").endsWith(".xlsx")) {
          await part.toBuffer();
          return reply.code(400).send({ error: `Файл «${filename || part.fieldname}» должен иметь формат .xlsx.` });
        }
        if (part.fieldname !== "specification" && part.fieldname !== "facades") {
          await part.toBuffer();
          return reply.code(400).send({ error: "Передайте файлы в полях specification и facades." });
        }
        if (uploaded.has(part.fieldname)) {
          await part.toBuffer();
          return reply.code(400).send({ error: "Файл спецификации или фасадов передан несколько раз." });
        }
        const buffer = await part.toBuffer();
        if (part.file.truncated || buffer.length > config.UPLOAD_MAX_BYTES) return reply.code(413).send({ error: `Файл превышает лимит ${Math.round(config.UPLOAD_MAX_BYTES / 1024 / 1024)} МБ.` });
        uploaded.set(part.fieldname, buffer);
        filenames.set(part.fieldname, filename);
      }
      const specification = uploaded.get("specification");
      const facades = uploaded.get("facades");
      if (!specification || !facades) return reply.code(400).send({ error: "Загрузите и спецификацию, и файл фасадов." });

      const settings = await getNetboxApiSettings(prisma);
      if (!settings.tokenConfigured) return reply.code(503).send({ error: "Для NetBox не настроен API-токен. Обратитесь к администратору." });
      const apiBase = new URL("/api/dcim/", settings.url);
      const headers = { Authorization: `${settings.tokenType} ${settings.token}`, Accept: "application/json" };
      const site = await findNetboxSite(apiBase, slug.data, headers);
      if (!site) return reply.code(404).send({ error: "Площадка не найдена в NetBox." });
      const deviceCount = await netboxSiteDeviceCount(apiBase, site.id, headers);
      if (deviceCount > 0) return reply.code(409).send({ error: `На площадке уже есть устройства (${deviceCount}). Для генерации нужна пустая площадка.` });

      const parsed = await parseSiteGeneratorFiles(specification, facades);
      const [deviceTypes, deviceRoles, manufacturers, locations, existingRacks] = await Promise.all([
        fetchNetboxCollection<{ id: number; model: string; slug?: string; u_height?: number | null }>(new URL("device-types/?limit=1000", apiBase), headers),
        fetchNetboxCollection<{ id: number; name: string; slug?: string }>(new URL("device-roles/?limit=1000", apiBase), headers),
        fetchNetboxCollection<{ id: number; name: string; slug?: string }>(new URL("manufacturers/?limit=1000", apiBase), headers),
        fetchNetboxCollection<{ id: number; name: string; site?: { id?: number } | null }>(new URL(`locations/?site_id=${site.id}&limit=1000`, apiBase), headers),
        fetchNetboxCollection<{ id: number; name: string; site?: { id?: number } | null }>(new URL(`racks/?site_id=${site.id}&limit=1000`, apiBase), headers)
      ]);
      const genericManufacturer = manufacturers.find((manufacturer) => manufacturer.name.trim().toLocaleLowerCase("ru") === "generic");
      let plan: SiteGeneratorPlan;
      try {
        plan = buildSiteGeneratorPlan(parsed, deviceTypes, deviceRoles, genericManufacturer, locations, existingRacks, site.id);
      } catch (error) {
        return reply.code(422).send({ error: error instanceof Error ? error.message : "Не удалось сопоставить спецификацию с фасадами и справочником NetBox." });
      }
      for (const [key, value] of siteGeneratorPreviews) if (value.expiresAt < Date.now()) siteGeneratorPreviews.delete(key);
      const previewId = randomUUID();
      siteGeneratorPreviews.set(previewId, {
        ownerId: String(request.sessionUser?.id ?? ""), siteSlug: site.slug, siteId: site.id, plan, expiresAt: Date.now() + 15 * 60_000
      });
      return {
        previewId,
        site,
        files: { specification: filenames.get("specification"), facades: filenames.get("facades") },
        counts: { devices: plan.devices.length, racks: plan.racks.length, placements: plan.devices.length, deviceTypesToCreate: plan.deviceTypesToCreate.length, manufacturerToCreate: plan.manufacturerToCreate, ignoredSpecificationItems: plan.ignoredItems.length, chassisOnlyDevices: plan.chassisOnlyDevices.length },
        deviceTypesToCreate: plan.deviceTypesToCreate.map(({ model, height }) => ({ model, height })),
        ignoredItems: plan.ignoredItems,
        chassisOnlyDevices: plan.chassisOnlyDevices,
        roomsWithoutLocation: plan.roomsWithoutLocation
      };
    } catch (error) {
      request.log.warn({ err: error, siteSlug: slug.data }, "Could not preview NetBox site generation");
      const message = error instanceof Error ? error.message : "Не удалось прочитать файлы для генерации площадки.";
      const tooLarge = /file too large|requestfiletoolarge/i.test(message);
      return reply.code(tooLarge ? 413 : 400).send({ error: tooLarge ? `Файл превышает лимит ${Math.round(config.UPLOAD_MAX_BYTES / 1024 / 1024)} МБ.` : message });
    }
  });

  app.post<{ Body: unknown }>("/api/daps/netbox/site/generator/create", { preHandler: writeAccess }, async (request, reply) => {
    const input = z.object({ previewId: z.string().uuid() }).safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "Не найден проверенный план создания площадки." });
    const preview = siteGeneratorPreviews.get(input.data.previewId);
    if (!preview || preview.expiresAt < Date.now() || preview.ownerId !== String(request.sessionUser?.id ?? "")) {
      siteGeneratorPreviews.delete(input.data.previewId);
      return reply.code(410).send({ error: "План создания истёк или недоступен. Проверьте файлы повторно." });
    }
    const settings = await getNetboxApiSettings(prisma);
    if (!settings.tokenConfigured) return reply.code(503).send({ error: "Для NetBox не настроен API-токен. Обратитесь к администратору." });
    const apiBase = new URL("/api/dcim/", settings.url);
    const headers = { Authorization: `${settings.tokenType} ${settings.token}`, Accept: "application/json" };
    const writeHeaders = { ...headers, "Content-Type": "application/json" };
    const createdRackIds: number[] = [];
    const createdDeviceIds: number[] = [];
    const createdDeviceTypeIds: number[] = [];
    let createdManufacturer = false;
    const typeModelKeys = preview.plan.deviceTypesToCreate.map(({ model }) => model.trim().toLocaleLowerCase("ru"));
    if (siteGeneratorActiveSites.has(preview.siteId)) return reply.code(409).send({ error: "Для этой площадки уже выполняется генерация." });
    if (typeModelKeys.some((key) => siteGeneratorActiveTypeModels.has(key))) return reply.code(409).send({ error: "Один из типов устройств уже создаётся в другой операции. Повторите попытку." });
    siteGeneratorActiveSites.add(preview.siteId);
    typeModelKeys.forEach((key) => siteGeneratorActiveTypeModels.add(key));
    try {
      const site = await findNetboxSite(apiBase, preview.siteSlug, headers);
      if (!site || site.id !== preview.siteId) return reply.code(404).send({ error: "Площадка изменилась или больше не найдена в NetBox." });
      const deviceCount = await netboxSiteDeviceCount(apiBase, site.id, headers);
      if (deviceCount > 0) return reply.code(409).send({ error: `На площадке появились устройства (${deviceCount}). Создание отменено.` });
      const currentRacks = await fetchNetboxCollection<{ id: number; name: string; site?: { id?: number } | null }>(new URL(`racks/?site_id=${site.id}&limit=1000`, apiBase), headers);
      const existingRackNames = new Set(currentRacks.map((rack) => rack.name.trim().toLocaleLowerCase("ru")));
      const duplicateRack = preview.plan.racks.find((rack) => existingRackNames.has(rack.name.trim().toLocaleLowerCase("ru")));
      if (duplicateRack) return reply.code(409).send({ error: `Стойка «${duplicateRack.name}» появилась после проверки. Выполните проверку файлов заново.` });

      const deviceTypeIdsByModel = new Map(preview.plan.devices.filter((device) => device.deviceTypeId !== undefined).map((device) => [device.deviceTypeModel.trim().toLocaleLowerCase("ru"), device.deviceTypeId!]));
      const currentTypes = await fetchNetboxCollection<{ id: number; model: string; slug?: string; manufacturer?: { id?: number } }>(new URL("device-types/?limit=1000", apiBase), headers);
      const usedSlugs = new Set(currentTypes.map((type) => type.slug?.trim().toLocaleLowerCase("en")).filter((slug): slug is string => Boolean(slug)));
      let genericManufacturerId: number | undefined;
      if (preview.plan.deviceTypesToCreate.length) {
        const manufacturers = await fetchNetboxCollection<{ id: number; name: string; slug?: string }>(new URL("manufacturers/?limit=1000", apiBase), headers);
        let generic = manufacturers.find((manufacturer) => manufacturer.name.trim().toLocaleLowerCase("ru") === "generic");
        if (!generic) {
          const usedManufacturerSlugs = new Set(manufacturers.map((manufacturer) => manufacturer.slug?.trim().toLocaleLowerCase("en")).filter((value): value is string => Boolean(value)));
          let manufacturerSlug = "generic";
          let suffix = 2;
          while (usedManufacturerSlugs.has(manufacturerSlug)) manufacturerSlug = `generic-${suffix++}`;
          const response = await fetch(new URL("manufacturers/", apiBase), {
            method: "POST", headers: writeHeaders,
            body: JSON.stringify({ name: "Generic", slug: manufacturerSlug }),
            signal: AbortSignal.timeout(20_000)
          });
          if (response.ok) {
            generic = await response.json() as { id: number; name: string; slug?: string };
            createdManufacturer = true;
          }
          else {
            generic = (await fetchNetboxCollection<{ id: number; name: string; slug?: string }>(new URL("manufacturers/?limit=1000", apiBase), headers))
              .find((manufacturer) => manufacturer.name.trim().toLocaleLowerCase("ru") === "generic");
            if (!generic) throw new Error(`NetBox не создал производителя Generic (HTTP ${response.status}). Проверьте права токена.`);
          }
        }
        genericManufacturerId = generic.id;
      }
      for (const type of preview.plan.deviceTypesToCreate) {
        const currentMatch = currentTypes.find((item) => item.model.trim().toLocaleLowerCase("ru") === type.model.trim().toLocaleLowerCase("ru") && item.manufacturer?.id === type.manufacturerId);
        if (currentMatch) {
          deviceTypeIdsByModel.set(type.model.trim().toLocaleLowerCase("ru"), currentMatch.id);
          continue;
        }
        const slugBase = type.model.normalize("NFKD").toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "device-type";
        let slug = slugBase.slice(0, 80);
        let suffix = 2;
        while (usedSlugs.has(slug.toLocaleLowerCase("en"))) {
          const ending = `-${suffix++}`;
          slug = `${slugBase.slice(0, 80 - ending.length)}${ending}`;
        }
        usedSlugs.add(slug.toLocaleLowerCase("en"));
        const response = await fetch(new URL("device-types/", apiBase), {
          method: "POST", headers: writeHeaders,
          body: JSON.stringify({ manufacturer: genericManufacturerId ?? type.manufacturerId, model: type.model, slug, u_height: type.height, is_full_depth: false }),
          signal: AbortSignal.timeout(20_000)
        });
        if (!response.ok) throw new Error(`NetBox не создал тип устройства «${type.model}» (HTTP ${response.status}). Проверьте права токена и производителя Generic.`);
        const createdType = await response.json() as { id: number };
        createdDeviceTypeIds.push(createdType.id);
        deviceTypeIdsByModel.set(type.model.trim().toLocaleLowerCase("ru"), createdType.id);
      }

      const rackIdsByName = new Map<string, number>();
      for (const rack of preview.plan.racks) {
        const response = await fetch(new URL("racks/", apiBase), {
          method: "POST", headers: writeHeaders,
          body: JSON.stringify({
            name: rack.name, site: site.id, status: "active", width: 19, u_height: rack.height, starting_unit: 1,
            form_factor: "4-post-cabinet", desc_units: false,
            ...(rack.facilityId ? { facility_id: rack.facilityId } : {}),
            ...(rack.locationId ? { location: rack.locationId } : {}),
            ...(rack.room ? { description: `Помещение: ${rack.room}` } : {})
          }), signal: AbortSignal.timeout(20_000)
        });
        if (!response.ok) throw new Error(`NetBox не создал стойку «${rack.name}» (HTTP ${response.status}).`);
        const created = await response.json() as { id: number };
        createdRackIds.push(created.id);
        rackIdsByName.set(rack.name.trim().toLocaleLowerCase("ru"), created.id);
      }
      for (const device of preview.plan.devices) {
        const rackId = rackIdsByName.get(device.rackName.trim().toLocaleLowerCase("ru"));
        if (!rackId) throw new Error(`Не найдена созданная стойка «${device.rackName}» для устройства «${device.name}».`);
        const deviceTypeId = device.deviceTypeId ?? deviceTypeIdsByModel.get(device.deviceTypeModel.trim().toLocaleLowerCase("ru"));
        if (!deviceTypeId) throw new Error(`Не найден тип NetBox «${device.deviceTypeModel}» для устройства «${device.name}».`);
        const response = await fetch(new URL("devices/", apiBase), {
          method: "POST", headers: writeHeaders,
          body: JSON.stringify({
            name: device.name, device_type: deviceTypeId, role: device.deviceRoleId, site: site.id,
            status: "active", rack: rackId, position: device.position, face: "front",
            description: "Создано генератором площадок по спецификации и файлу фасадов."
          }), signal: AbortSignal.timeout(20_000)
        });
        if (!response.ok) throw new Error(`NetBox не создал устройство «${device.name}» (HTTP ${response.status}).`);
        const created = await response.json() as { id: number };
        createdDeviceIds.push(created.id);
      }
      siteGeneratorPreviews.delete(input.data.previewId);
      return {
        success: true, site,
        created: { devices: createdDeviceIds.length, racks: createdRackIds.length, deviceTypes: createdDeviceTypeIds.length, manufacturer: createdManufacturer },
        ignoredItems: preview.plan.ignoredItems,
        chassisOnlyDevices: preview.plan.chassisOnlyDevices,
        roomsWithoutLocation: preview.plan.roomsWithoutLocation
      };
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const id of createdDeviceIds.reverse()) {
        try {
          const response = await fetch(new URL(`devices/${id}/`, apiBase), { method: "DELETE", headers, signal: AbortSignal.timeout(15_000) });
          if (!response.ok) rollbackFailures.push(`device:${id}`);
        } catch { rollbackFailures.push(`device:${id}`); }
      }
      for (const id of createdRackIds.reverse()) {
        try {
          const response = await fetch(new URL(`racks/${id}/`, apiBase), { method: "DELETE", headers, signal: AbortSignal.timeout(15_000) });
          if (!response.ok) rollbackFailures.push(`rack:${id}`);
        } catch { rollbackFailures.push(`rack:${id}`); }
      }
      for (const id of createdDeviceTypeIds.reverse()) {
        try {
          const response = await fetch(new URL(`device-types/${id}/`, apiBase), { method: "DELETE", headers, signal: AbortSignal.timeout(15_000) });
          if (!response.ok) rollbackFailures.push(`device-type:${id}`);
        } catch { rollbackFailures.push(`device-type:${id}`); }
      }
      request.log.error({ err: error, siteSlug: preview.siteSlug, rollbackFailures }, "NetBox site generation failed; rollback attempted");
      const rollbackMessage = `${rollbackFailures.length ? ` Не удалось удалить после сбоя объекты: ${rollbackFailures.join(", ")}.` : " Частично созданные типы, устройства и стойки удалены."}${createdManufacturer ? " Производитель Generic оставлен в NetBox и доступен для повторной генерации." : ""}`;
      return reply.code(502).send({ error: `${error instanceof Error ? error.message : "Генерация площадки завершилась ошибкой."}${rollbackMessage}`, rollbackFailures });
    } finally {
      siteGeneratorActiveSites.delete(preview.siteId);
      typeModelKeys.forEach((key) => siteGeneratorActiveTypeModels.delete(key));
    }
  });

  app.get<{ Querystring: { slug?: string } }>("/api/daps/netbox/site/clear-preview", { preHandler: readAccess }, async (request, reply) => {
    const slug = z.string().trim().min(1).max(100).safeParse(request.query.slug);
    if (!slug.success) return reply.code(400).send({ error: "Введите номер площадки." });
    const settings = await getNetboxApiSettings(prisma);
    if (!settings.tokenConfigured) return reply.code(503).send({ error: "Для NetBox не настроен API-токен. Обратитесь к администратору." });
    const apiBase = new URL("/api/dcim/", settings.url);
    const headers = { Authorization: `${settings.tokenType} ${settings.token}`, Accept: "application/json" };
    try {
      const site = await findNetboxSite(apiBase, slug.data, headers);
      if (!site) return { found: false };
      const inventory = await getNetboxSiteInventory(apiBase, site.id, headers);
      return { found: true, site, counts: { cables: inventory.cables.length, devices: inventory.devices.length, racks: inventory.racks.length } };
    } catch (error) {
      request.log.warn({ err: error, siteSlug: slug.data }, "Could not preview NetBox site cleanup");
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Не удалось проверить объекты площадки в NetBox." });
    }
  });

  app.post<{ Body: unknown }>("/api/daps/netbox/site/clear", { preHandler: writeAccess }, async (request, reply) => {
    const input = z.object({
      siteSlug: z.string().trim().min(1).max(100),
      confirmation: z.string().trim().min(1).max(100),
      expected: z.object({ cables: z.number().int().nonnegative(), devices: z.number().int().nonnegative(), racks: z.number().int().nonnegative() })
    }).safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "Проверьте данные подтверждения очистки площадки." });
    if (input.data.confirmation !== input.data.siteSlug) return reply.code(400).send({ error: "Для подтверждения введите точный номер площадки." });
    const settings = await getNetboxApiSettings(prisma);
    if (!settings.tokenConfigured) return reply.code(503).send({ error: "Для NetBox не настроен API-токен. Обратитесь к администратору." });
    const apiBase = new URL("/api/dcim/", settings.url);
    const headers = { Authorization: `${settings.tokenType} ${settings.token}`, Accept: "application/json" };
    try {
      const site = await findNetboxSite(apiBase, input.data.siteSlug, headers);
      if (!site) return reply.code(404).send({ error: "Площадка не найдена в NetBox." });
      const inventory = await getNetboxSiteInventory(apiBase, site.id, headers);
      const actual = { cables: inventory.cables.length, devices: inventory.devices.length, racks: inventory.racks.length };
      if (actual.cables !== input.data.expected.cables || actual.devices !== input.data.expected.devices || actual.racks !== input.data.expected.racks) {
        return reply.code(409).send({ error: "Состав площадки изменился после проверки. Выполните поиск заново и проверьте новые количества.", counts: actual });
      }
      const deleted = { cables: 0, devices: 0, racks: 0 };
      const deleteResources = async <T extends { id: number }>(path: string, resources: T[]) => {
        const failedIds: number[] = [];
        for (let offset = 0; offset < resources.length; offset += 8) {
          const results = await Promise.all(resources.slice(offset, offset + 8).map(async ({ id }) => {
            try {
              return await fetch(new URL(`${path}/${id}/`, apiBase), { method: "DELETE", headers, signal: AbortSignal.timeout(15_000) });
            } catch {
              return null;
            }
          }));
          results.forEach((response, index) => {
            if (response?.ok) deleted[path === "cables" ? "cables" : path === "devices" ? "devices" : "racks"] += 1;
            else failedIds.push(resources[offset + index].id);
          });
        }
        return failedIds;
      };
      const failedCables = await deleteResources("cables", inventory.cables);
      if (failedCables.length) return reply.code(502).send({ error: "Не удалось удалить часть кабелей. Устройства и стойки не удалялись.", deleted, failedIds: failedCables });
      const failedDevices = await deleteResources("devices", inventory.devices);
      if (failedDevices.length) return reply.code(502).send({ error: "Не удалось удалить часть устройств. Стойки не удалялись.", deleted, failedIds: failedDevices });
      const failedRacks = await deleteResources("racks", inventory.racks);
      if (failedRacks.length) return reply.code(502).send({ error: "Не удалось удалить часть стоек площадки.", deleted, failedIds: failedRacks });
      return { success: true, site, deleted };
    } catch (error) {
      request.log.warn({ err: error, siteSlug: input.data.siteSlug }, "Could not clear NetBox site");
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Не удалось очистить площадку в NetBox." });
    }
  });

  app.put<{ Body: { siteSlug?: string; sourceDeviceId?: number; sourceInterfaceId?: number; hostName?: string; portName?: string } }>("/api/daps/netbox/interface", { preHandler: writeAccess }, async (request, reply) => {
    const input = z.object({
      siteSlug: z.string().trim().min(1).max(100),
      sourceDeviceId: z.number().int().positive(),
      sourceInterfaceId: z.number().int().positive(),
      hostName: z.string().trim().min(1).max(200),
      portName: z.string().trim().min(1).max(200)
    }).safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: input.error.issues[0]?.message ?? "Проверьте имя хоста и порта ОС." });
    const settings = await getNetboxApiSettings(prisma);
    if (!settings.tokenConfigured) return reply.code(503).send({ error: "Для NetBox не настроен API-токен. Обратитесь к администратору." });

    const apiBase = new URL("/api/dcim/", settings.url);
    const headers = { Authorization: `${settings.tokenType} ${settings.token}`, Accept: "application/json" };
    const writeHeaders = { ...headers, "Content-Type": "application/json" };
    const requestJson = async (url: URL, init: RequestInit = {}) => fetch(url, { ...init, headers: init.headers ?? headers, signal: init.signal ?? AbortSignal.timeout(10_000) });
    const isOsRole = (device: { role?: { id?: number; name?: string } | null; device_role?: { id?: number; name?: string } | null }) => {
      const role = device.role?.name ?? device.device_role?.name;
      return role === "Устройство LAN" || role === "Устройство WAN";
    };
    try {
      const siteUrl = new URL("sites/", apiBase);
      siteUrl.searchParams.set("slug", input.data.siteSlug);
      const siteResponse = await requestJson(siteUrl);
      if (!siteResponse.ok) return reply.code(502).send({ error: "Не удалось проверить площадку в NetBox перед сохранением." });
      const siteData = await siteResponse.json() as { results?: { id: number; slug: string }[] };
      const site = siteData.results?.find((item) => item.slug === input.data.siteSlug);
      if (!site) return reply.code(404).send({ error: "Площадка не найдена в NetBox." });

      const sourceDeviceResponse = await requestJson(new URL(`devices/${input.data.sourceDeviceId}/`, apiBase));
      if (!sourceDeviceResponse.ok) return reply.code(404).send({ error: "Исходный хост ОС не найден в NetBox." });
      const sourceDevice = await sourceDeviceResponse.json() as {
        id: number; name?: string | null; site?: { id?: number } | null; role?: { id?: number; name?: string } | null; device_role?: { id?: number; name?: string } | null;
        device_type?: { id?: number; u_height?: number } | null; status?: { value?: string } | null;
      };
      if (sourceDevice.site?.id !== site.id || !isOsRole(sourceDevice)) return reply.code(403).send({ error: "Можно переносить только интерфейсы устройств ОС на выбранной площадке." });
      const sourceInterfaceResponse = await requestJson(new URL(`interfaces/${input.data.sourceInterfaceId}/`, apiBase));
      if (!sourceInterfaceResponse.ok) return reply.code(404).send({ error: "Исходный порт ОС не найден в NetBox." });
      const sourceInterface = await sourceInterfaceResponse.json() as {
        id: number; name: string; device?: { id?: number } | null; type?: { value?: string } | null; enabled?: boolean; mgmt_only?: boolean;
        cable?: { id?: number } | null;
      };
      if (sourceInterface.device?.id !== sourceDevice.id) return reply.code(403).send({ error: "Указанный порт не принадлежит исходному хосту ОС." });
      if (!sourceInterface.cable?.id) return reply.code(409).send({ error: "У исходного порта нет кабельного соединения. Перенос линка отменён." });

      const sourceInterfacesUrl = new URL("interfaces/", apiBase);
      sourceInterfacesUrl.searchParams.set("device_id", String(sourceDevice.id));
      sourceInterfacesUrl.searchParams.set("limit", "1000");
      const sourceInterfacesResponse = await requestJson(sourceInterfacesUrl);
      if (!sourceInterfacesResponse.ok) return reply.code(502).send({ error: "Не удалось проверить порты исходного Хоста ОС." });
      const sourceInterfacesData = await sourceInterfacesResponse.json() as { count?: number; results?: { id: number }[] };
      const sourceInterfaceCount = sourceInterfacesData.count ?? sourceInterfacesData.results?.length ?? 0;

      const devicesUrl = new URL("devices/", apiBase);
      devicesUrl.searchParams.set("site_id", String(site.id));
      devicesUrl.searchParams.set("name", input.data.hostName);
      devicesUrl.searchParams.set("limit", "1000");
      const devicesResponse = await requestJson(devicesUrl);
      if (!devicesResponse.ok) return reply.code(502).send({ error: "Не удалось найти целевой хост ОС в NetBox." });
      const devicesData = await devicesResponse.json() as { results?: { id: number; name?: string; site?: { id?: number }; role?: { id?: number; name?: string }; device_role?: { id?: number; name?: string }; rack?: { id?: number } | null; position?: number | string | null }[] };
      let targetDevice = devicesData.results?.find((device) => device.name === input.data.hostName);
      if (targetDevice && (targetDevice.site?.id !== site.id || !isOsRole(targetDevice))) return reply.code(409).send({ error: "Хост с таким именем найден, но его роль или площадка не совпадает с устройством ОС." });
      const deviceTypeId = sourceDevice.device_type?.id;
      if (!deviceTypeId) return reply.code(502).send({ error: "Не удалось определить тип исходного хоста ОС." });
      const deviceTypeResponse = await requestJson(new URL(`device-types/${deviceTypeId}/`, apiBase));
      if (!deviceTypeResponse.ok) return reply.code(502).send({ error: "Не удалось прочитать высоту типа устройства NetBox." });
      const deviceType = await deviceTypeResponse.json() as { u_height?: number };
      const deviceHeight = Number(deviceType.u_height);
      if (!Number.isFinite(deviceHeight) || deviceHeight <= 0) return reply.code(409).send({ error: "У типа этого Хоста ОС задана высота 0U. Укажите высоту устройства в NetBox, чтобы назначить ему юнит стойки." });

      const racksUrl = new URL("racks/", apiBase);
      racksUrl.searchParams.set("site_id", String(site.id));
      racksUrl.searchParams.set("name", "LAN & WAN (fake)");
      racksUrl.searchParams.set("limit", "1000");
      const racksResponse = await requestJson(racksUrl);
      if (!racksResponse.ok) return reply.code(502).send({ error: "Не удалось найти стойку LAN & WAN (fake) в NetBox." });
      const racksData = await racksResponse.json() as { results?: { id: number; name: string; site?: { id?: number }; u_height?: number; starting_unit?: number; descending_units?: boolean }[] };
      const rack = racksData.results?.find((item) => item.name === "LAN & WAN (fake)" && item.site?.id === site.id);
      if (!rack) return reply.code(424).send({ error: "На площадке не найдена стойка «LAN & WAN (fake)». Хост ОС не создан." });

      const needsRackPlacement = !targetDevice || !targetDevice.rack || (targetDevice.rack.id === rack.id && targetDevice.position == null);
      let position: number | null = targetDevice?.position == null ? null : Number(targetDevice.position);
      if (needsRackPlacement) {
        const rackDevicesUrl = new URL("devices/", apiBase);
        rackDevicesUrl.searchParams.set("rack_id", String(rack.id));
        rackDevicesUrl.searchParams.set("limit", "1000");
        const rackDevicesResponse = await requestJson(rackDevicesUrl);
        if (!rackDevicesResponse.ok) return reply.code(502).send({ error: "Не удалось определить свободное место в стойке NetBox." });
        const rackDevicesData = await rackDevicesResponse.json() as { results?: { position?: number | string | null; device_type?: { id?: number; u_height?: number } | null }[] };
        const rackHeight = Number(rack.u_height ?? 0);
        const rackStart = Number(rack.starting_unit ?? 1);
        if (!Number.isFinite(rackHeight) || rackHeight <= 0 || deviceHeight > rackHeight) return reply.code(409).send({ error: "Высота стойки или устройства не позволяет назначить позицию." });
        const placedDeviceTypeIds = [...new Set((rackDevicesData.results ?? [])
          .map((placed) => placed.device_type?.id)
          .filter((id): id is number => typeof id === "number"))];
        const placedTypeHeights = new Map<number, number>([[deviceTypeId, deviceHeight]]);
        const otherTypeIds = placedDeviceTypeIds.filter((id) => id !== deviceTypeId && !(rackDevicesData.results ?? []).some((placed) => placed.device_type?.id === id && typeof placed.device_type.u_height === "number"));
        const fetchedTypeHeights = await Promise.all(otherTypeIds.map(async (id) => {
          const response = await requestJson(new URL(`device-types/${id}/`, apiBase));
          if (!response.ok) throw new Error("Could not retrieve rack device type height");
          const data = await response.json() as { u_height?: number };
          return [id, Number(data.u_height)] as const;
        })).catch(() => null);
        if (!fetchedTypeHeights) return reply.code(502).send({ error: "Не удалось прочитать высоту устройств, уже установленных в стойке." });
        for (const [id, height] of fetchedTypeHeights) placedTypeHeights.set(id, height);
        const firstPosition = Math.round(rackStart * 2);
        const lastPosition = Math.round((rackStart + rackHeight) * 2) - 1;
        const deviceHeightSteps = Math.round(deviceHeight * 2);
        const occupiedPositions = new Set<number>();
        for (const placed of rackDevicesData.results ?? []) {
          const placedPosition = Number(placed.position);
          const placedHeight = placed.device_type?.u_height ?? (placed.device_type?.id ? placedTypeHeights.get(placed.device_type.id) : undefined) ?? 0;
          const placedHeightSteps = Math.round(Number(placedHeight) * 2);
          if (!Number.isFinite(placedPosition) || placedHeightSteps <= 0) continue;
          for (let step = Math.round(placedPosition * 2); step < Math.round(placedPosition * 2) + placedHeightSteps; step += 1) occupiedPositions.add(step);
        }
        const candidates: number[] = [];
        if (rack.descending_units) {
          for (let candidate = lastPosition - deviceHeightSteps + 1; candidate >= firstPosition; candidate -= 1) candidates.push(candidate);
        } else {
          for (let candidate = firstPosition; candidate <= lastPosition - deviceHeightSteps + 1; candidate += 1) candidates.push(candidate);
        }
        const positionSteps = candidates.find((candidate) => Array.from({ length: deviceHeightSteps }, (_, offset) => candidate + offset).every((step) => !occupiedPositions.has(step)));
        position = positionSteps === undefined ? null : positionSteps / 2;
        if (position === null) return reply.code(409).send({ error: "В стойке «LAN & WAN (fake)» не осталось свободного места для Хоста ОС." });
      }

      if (!targetDevice) {
        const roleId = sourceDevice.role?.id ?? sourceDevice.device_role?.id;
        if (!roleId) return reply.code(502).send({ error: "Не удалось определить роль исходного хоста для создания нового устройства." });
        const createDeviceBody: Record<string, unknown> = {
          name: input.data.hostName, site: site.id, device_type: deviceTypeId,
          status: sourceDevice.status?.value ?? "active", rack: rack.id, face: "front",
          ...(position !== null ? { position } : {})
        };
        createDeviceBody[sourceDevice.role ? "role" : "device_role"] = roleId;
        const createdDeviceResponse = await requestJson(new URL("devices/", apiBase), { method: "POST", headers: writeHeaders, body: JSON.stringify(createDeviceBody) });
        if (!createdDeviceResponse.ok) {
          request.log.warn({ statusCode: createdDeviceResponse.status, sourceDeviceId: sourceDevice.id }, "NetBox OS device creation failed");
          return reply.code(502).send({ error: "Не удалось создать хост ОС в NetBox. Проверьте права и обязательные поля устройства." });
        }
        targetDevice = await createdDeviceResponse.json() as NonNullable<typeof targetDevice>;
      } else if (needsRackPlacement) {
        const placementResponse = await requestJson(new URL(`devices/${targetDevice.id}/`, apiBase), {
          method: "PATCH", headers: writeHeaders,
          body: JSON.stringify({ rack: rack.id, face: "front", position })
        });
        if (!placementResponse.ok) {
          request.log.warn({ statusCode: placementResponse.status, targetDeviceId: targetDevice.id, rackId: rack.id, position }, "NetBox OS device rack placement failed");
          return reply.code(502).send({ error: "Не удалось назначить Хосту ОС юнит в стойке NetBox." });
        }
      }

      const interfacesUrl = new URL("interfaces/", apiBase);
      interfacesUrl.searchParams.set("device_id", String(targetDevice.id));
      interfacesUrl.searchParams.set("name", input.data.portName);
      interfacesUrl.searchParams.set("limit", "1000");
      const interfacesResponse = await requestJson(interfacesUrl);
      if (!interfacesResponse.ok) return reply.code(502).send({ error: "Не удалось проверить порт на целевом хосте ОС." });
      const interfacesData = await interfacesResponse.json() as { results?: { id: number; name: string; cable?: { id?: number } | null; device?: { id?: number } | null }[] };
      let targetInterface = interfacesData.results?.find((item) => item.name === input.data.portName);
      if (!targetInterface) {
        if (!sourceInterface.type?.value) return reply.code(502).send({ error: "Не удалось определить тип исходного порта для создания нового интерфейса." });
        const createdInterfaceResponse = await requestJson(new URL("interfaces/", apiBase), {
          method: "POST", headers: writeHeaders,
          body: JSON.stringify({ device: targetDevice.id, name: input.data.portName, type: sourceInterface.type.value, enabled: sourceInterface.enabled, mgmt_only: sourceInterface.mgmt_only })
        });
        if (!createdInterfaceResponse.ok) {
          request.log.warn({ statusCode: createdInterfaceResponse.status, targetDeviceId: targetDevice.id }, "NetBox OS interface creation failed");
          return reply.code(502).send({ error: "Не удалось создать порт ОС на целевом хосте в NetBox." });
        }
        targetInterface = await createdInterfaceResponse.json() as NonNullable<typeof targetInterface>;
      }
      if (targetInterface.id === sourceInterface.id) return { saved: true, deviceId: targetDevice.id, interfaceId: targetInterface.id, host: input.data.hostName, port: input.data.portName };
      if (targetInterface.cable?.id) return reply.code(409).send({ error: "Дубликат", code: "DUPLICATE_LINK", duplicateDeviceId: targetDevice.id, duplicateInterfaceId: targetInterface.id });

      const cableUrl = new URL(`cables/${sourceInterface.cable.id}/`, apiBase);
      const cableResponse = await requestJson(cableUrl);
      if (!cableResponse.ok) return reply.code(502).send({ error: "Не удалось загрузить кабель исходного линка из NetBox." });
      const cable = await cableResponse.json() as {
        a_terminations?: { object_type?: string; object_id?: number }[]; b_terminations?: { object_type?: string; object_id?: number }[];
      };
      const replaceTermination = (items: { object_type?: string; object_id?: number }[] | undefined) => {
        if (!items) return null;
        let found = false;
        const updated = items.map((termination) => {
          if (termination.object_type === "dcim.interface" && termination.object_id === sourceInterface.id) {
            found = true;
            return { object_type: "dcim.interface", object_id: targetInterface!.id };
          }
          return { object_type: termination.object_type, object_id: termination.object_id };
        });
        return found ? updated : null;
      };
      const aTerminations = replaceTermination(cable.a_terminations);
      const bTerminations = replaceTermination(cable.b_terminations);
      if (!aTerminations && !bTerminations) return reply.code(409).send({ error: "Исходный порт не найден среди окончаний кабеля; линк не изменён." });
      const cableUpdateResponse = await requestJson(cableUrl, {
        method: "PATCH", headers: writeHeaders,
        body: JSON.stringify(aTerminations ? { a_terminations: aTerminations } : { b_terminations: bTerminations })
      });
      if (!cableUpdateResponse.ok) {
        request.log.warn({ statusCode: cableUpdateResponse.status, cableId: sourceInterface.cable.id }, "NetBox cable termination update failed");
        return reply.code(502).send({ error: "NetBox не переподключил линк. Проверьте права токена на изменение кабелей." });
      }
      let linkUpdatedAt = new Date().toISOString();
      try {
        const updatedCable = await cableUpdateResponse.json() as { last_updated?: string };
        linkUpdatedAt = updatedCable.last_updated ?? linkUpdatedAt;
      } catch {
        // NetBox may return an empty response after a successful cable update.
      }
      let cleanupWarning: string | undefined;
      const deleteNetboxResource = async (url: URL) => {
        try {
          return await requestJson(url, { method: "DELETE" });
        } catch {
          return null;
        }
      };
      const sourceHostWillBeRemoved = sourceDevice.id !== targetDevice.id && sourceInterfaceCount === 1;
      if (sourceHostWillBeRemoved) {
        const deleteDeviceResponse = await deleteNetboxResource(new URL(`devices/${sourceDevice.id}/`, apiBase));
        if (!deleteDeviceResponse?.ok) {
          const deletePortResponse = await deleteNetboxResource(new URL(`interfaces/${sourceInterface.id}/`, apiBase));
          cleanupWarning = deletePortResponse?.ok
            ? "Кабель перенесён, но NetBox не удалил старый Хост ОС. Его пустой порт удалён."
            : "Кабель перенесён, но NetBox не удалил старый Хост ОС и его порт.";
        }
      } else {
        const deletePortResponse = await deleteNetboxResource(new URL(`interfaces/${sourceInterface.id}/`, apiBase));
        if (!deletePortResponse?.ok) cleanupWarning = "Кабель перенесён, но NetBox не удалил старый Порт ОС.";
      }
      return { saved: true, deviceId: targetDevice.id, interfaceId: targetInterface.id, host: input.data.hostName, port: input.data.portName, linkUpdatedAt, ...(cleanupWarning ? { cleanupWarning } : {}) };
    } catch {
      return reply.code(502).send({ error: "Не удалось связаться с NetBox для сохранения изменения." });
    }
  });

  app.post<{ Body: unknown }>("/api/daps/netbox/site.xlsx", { preHandler: readAccess }, async (request, reply) => {
    const parsed = netboxExportSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Не удалось сформировать XLSX: проверьте данные таблицы." });
    try {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Линки");
      worksheet.columns = [
        { header: "№", key: "number", width: 8 },
        { header: "Дата изменения линка", key: "linkUpdatedAt", width: 24 },
        { header: "Хост ОС", key: "host", width: 36 },
        { header: "Порт ОС", key: "port", width: 20 },
        { header: "Хост Байпаса", key: "bypassHost", width: 36 },
        { header: "Порт Байпаса", key: "bypassPort", width: 24 }
      ];
      const includeExtraFields = parsed.data.rows.some((row) => row.behindDevice !== undefined || row.behindPort !== undefined || row.linkCapacity !== undefined);
      if (includeExtraFields) worksheet.columns = [
        ...worksheet.columns,
        { header: "Устройство за байпасом", key: "behindDevice", width: 36 },
        { header: "Порт устройства", key: "behindPort", width: 24 },
        { header: "Линк", key: "linkCapacity", width: 24 }
      ];
      worksheet.addRows(parsed.data.rows.map((row) => ({
        number: row.tspuId,
        host: row.host,
        port: row.port,
        linkUpdatedAt: Number.isFinite(new Date(row.linkUpdatedAt).getTime()) ? new Date(row.linkUpdatedAt) : row.linkUpdatedAt,
        bypassHost: row.bypassHost,
        bypassPort: row.bypassPort,
        behindDevice: row.behindDevice,
        behindPort: row.behindPort,
        linkCapacity: row.linkCapacity
      })));
      worksheet.getRow(1).font = { bold: true };
      worksheet.getColumn("linkUpdatedAt").numFmt = "dd.mm.yyyy hh:mm";
      worksheet.views = [{ state: "frozen", ySplit: 1 }];
      worksheet.autoFilter = { from: "A1", to: includeExtraFields ? "I1" : "F1" };
      const buffer = await workbook.xlsx.writeBuffer();
      const filenameSlug = parsed.data.siteSlug.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "site";
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="netbox-links-${filenameSlug}.xlsx"`)
        .send(Buffer.from(buffer));
    } catch (error) {
      app.log.error({ err: error }, "Could not export NetBox links to XLSX");
      return reply.code(500).send({ error: "Не удалось сформировать XLSX с линками площадки." });
    }
  });

  app.post("/api/daps/netbox/site.xlsx/parse", { preHandler: writeAccess }, async (request, reply) => {
    if (!request.isMultipart()) return reply.code(406).send({ error: "Ожидается XLSX-файл в формате multipart/form-data." });
    try {
      const upload = await request.file();
      if (!upload) return reply.code(400).send({ error: "Выберите XLSX-файл с таблицей линков." });
      const filename = upload.filename.split(/[\\/]/).pop() ?? "";
      if (!filename.toLocaleLowerCase("en").endsWith(".xlsx")) {
        await upload.toBuffer();
        return reply.code(400).send({ error: "Поддерживаются файлы .xlsx." });
      }
      const buffer = await upload.toBuffer();
      if (upload.file.truncated || buffer.length > config.UPLOAD_MAX_BYTES) return reply.code(413).send({ error: `Файл превышает лимит ${Math.round(config.UPLOAD_MAX_BYTES / 1024 / 1024)} МБ.` });
      const workbook = new ExcelJS.Workbook();
      const workbookData = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
      await workbook.xlsx.load(workbookData);
      const worksheet = workbook.worksheets[0];
      if (!worksheet || worksheet.rowCount < 2) return reply.code(400).send({ error: "В XLSX нет строк с линками." });
      const normalizeHeader = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
      const headers = new Map<string, number>();
      worksheet.getRow(1).eachCell((cell, column) => headers.set(normalizeHeader(cell.text), column));
      const requiredColumns = ["хост ос", "порт ос", "хост байпаса", "порт байпаса"];
      const missingColumns = requiredColumns.filter((header) => !headers.has(header));
      if (missingColumns.length) return reply.code(400).send({ error: `В XLSX отсутствуют столбцы: ${missingColumns.join(", ")}.` });
      const getValue = (row: ExcelJS.Row, header: string) => row.getCell(headers.get(header)!).text.trim();
      const rows: { rowNumber: number; host: string; port: string; bypassHost: string; bypassPort: string }[] = [];
      for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
        const row = worksheet.getRow(rowNumber);
        const values = requiredColumns.map((header) => getValue(row, header));
        if (values.every((value) => value === "")) continue;
        const [host, port, bypassHost, bypassPort] = values;
        if (!bypassHost || !bypassPort) return reply.code(400).send({ error: `В строке ${rowNumber} не заполнены Хост Байпаса и/или Порт Байпаса.` });
        if (!host || !port) return reply.code(400).send({ error: `В строке ${rowNumber} не заполнены Хост ОС и/или Порт ОС.` });
        rows.push({ rowNumber, host, port, bypassHost, bypassPort });
      }
      if (rows.length === 0) return reply.code(400).send({ error: "В XLSX нет строк с линками." });
      return { rows };
    } catch (error) {
      app.log.warn({ err: error }, "Could not parse uploaded NetBox XLSX");
      return reply.code(400).send({ error: "Не удалось прочитать XLSX. Проверьте файл и заголовки столбцов." });
    }
  });

  app.get<{ Querystring: { slug?: string; progressId?: string } }>("/api/daps/netbox/site/progress", { preHandler: readAccess }, async (request, reply) => {
    const progress = netboxLookupProgress.get(request.query.progressId ?? "");
    if (!progress || Date.now() - progress.updatedAt > 10 * 60_000) return reply.code(404).send({ error: "Прогресс поиска не найден." });
    return progress;
  });

  app.get<{ Querystring: { slug?: string; progressId?: string } }>("/api/daps/netbox/site", { preHandler: readAccess }, async (request, reply) => {
    const slug = z.string().trim().min(1).max(100).safeParse(request.query.slug);
    if (!slug.success) return reply.code(400).send({ error: "Введите номер площадки." });
    const progressId = z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/).safeParse(request.query.progressId);
    for (const [key, value] of netboxLookupProgress) if (Date.now() - value.updatedAt > 10 * 60_000) netboxLookupProgress.delete(key);
    const progress: { slug: string; phase: string; percent: number; interfaces: unknown[]; done: boolean; error?: string; updatedAt: number } | null = progressId.success
      ? { slug: slug.data, phase: "Ищем площадку…", percent: 3, interfaces: [], done: false, updatedAt: Date.now() }
      : null;
    if (progress && progressId.success) netboxLookupProgress.set(progressId.data, progress);
    const updateProgress = (phase: string, percent: number, interfaces?: unknown[], done = false, error?: string) => {
      if (!progress) return;
      progress.phase = phase; progress.percent = percent; progress.updatedAt = Date.now(); progress.done = done;
      if (interfaces) progress.interfaces = interfaces;
      if (error) progress.error = error;
    };
    const settings = await getNetboxApiSettings(prisma);
    if (!settings.tokenConfigured) return reply.code(503).send({ error: "Для NetBox не настроен API-токен. Обратитесь к администратору." });

    const url = new URL("/api/dcim/sites/", settings.url);
    url.searchParams.set("slug", slug.data);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `${settings.tokenType} ${settings.token}`,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      return reply.code(502).send({ error: "Не удалось связаться с NetBox. Проверьте адрес контейнера и доступность API." });
    }
    if (!response.ok) {
      request.log.warn({ statusCode: response.status }, "NetBox site lookup failed");
      return reply.code(502).send({ error: "NetBox отклонил запрос. Проверьте API-токен и права чтения площадок." });
    }

    let data: { results?: { id?: number; name?: string; slug?: string }[] };
    try {
      data = await response.json() as typeof data;
    } catch {
      return reply.code(502).send({ error: "NetBox вернул некорректный ответ." });
    }
    const site = data.results?.find((item) => item.slug === slug.data);
    if (!site) { updateProgress("Площадка не найдена", 100, [], true); return { found: false, site: null, interfaces: [] }; }
    updateProgress("Загружаем устройства площадки…", 12);

    const apiBase = new URL("/api/dcim/", settings.url);
    let siteDevices: { id: number; name: string; role?: { name?: string } | null; device_role?: { name?: string } | null }[];
    try {
      const devicesUrl = new URL("devices/", apiBase);
      devicesUrl.searchParams.set("site_id", String(site.id));
      devicesUrl.searchParams.set("limit", "1000");
      const devicesResponse = await fetch(devicesUrl, {
        headers: { Authorization: `${settings.tokenType} ${settings.token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000)
      });
      if (!devicesResponse.ok) {
        request.log.warn({ statusCode: devicesResponse.status }, "NetBox site device lookup failed");
        return reply.code(502).send({ error: "Не удалось загрузить устройства площадки из NetBox." });
      }
      const devicesData = await devicesResponse.json() as { results?: typeof siteDevices };
      siteDevices = devicesData.results ?? [];
    } catch {
      return reply.code(502).send({ error: "Не удалось загрузить устройства площадки из NetBox." });
    }
    type NetboxPeer = { id: number; url?: string; name?: string | null; display?: string; device?: { id?: number; name?: string | null } | null };
    type NetboxDevice = (typeof siteDevices)[number];
    type LinkedPorts = { link_peers?: NetboxPeer[] | null; link_peer?: NetboxPeer | null; cable_peer?: NetboxPeer | null; connected_endpoints?: NetboxPeer[] | null };
    type OdfPort = LinkedPorts & { id: number; name: string; device?: { id?: number } | null; custom_fields?: Record<string, unknown> | null; rear_ports?: { rear_port: number }[]; front_ports?: { front_port: number }[] };
    const deviceById = new Map(siteDevices.map((device) => [device.id, device]));
    const bypassRoleNames = new Set(settings.bypassRoles);
    const isBypassRole = (role?: string) => role !== undefined && bypassRoleNames.has(role);
    const roleName = (device: NetboxDevice | undefined) => device?.role?.name ?? device?.device_role?.name ?? "";
    const tspuId = (customFields: Record<string, unknown> | null | undefined) => {
      const entry = Object.entries(customFields ?? {}).find(([key]) => key.toLocaleLowerCase("en").replace(/[^a-z0-9]/g, "") === "tspuid");
      const value = entry?.[1];
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
    };
    const peerList = (item: LinkedPorts) => {
      if (Object.prototype.hasOwnProperty.call(item, "link_peers")) return item.link_peers ?? [];
      if (item.link_peer) return [item.link_peer];
      if (item.cable_peer) return [item.cable_peer];
      return item.connected_endpoints ?? [];
    };
    const odfDevices = siteDevices.filter((device) => roleName(device) === "ODF оператора");
    const bypassDevices = siteDevices.filter((device) => isBypassRole(roleName(device)));
    const osDevices = siteDevices.filter((device) => roleName(device) === "Устройство LAN" || roleName(device) === "Устройство WAN");
    updateProgress(`Обрабатываем топологию: ${osDevices.length} устройств ОС`, 25);
    const authHeaders = { Authorization: `${settings.tokenType} ${settings.token}`, Accept: "application/json" };
    const networkPortsByNode = new Map<string, { port: OdfPort; kind: "front" | "rear" }>();
    const odfLinks = new Map<string, Set<string>>();
    const endpointKind = (peer: NetboxPeer): "front" | "rear" | "interface" | null => {
      if (peer.url?.includes("/front-ports/")) return "front";
      if (peer.url?.includes("/rear-ports/")) return "rear";
      if (peer.url?.includes("/interfaces/")) return "interface";
      return null;
    };
    const nodeKey = (kind: "front" | "rear", id: number) => `${kind}:${id}`;
    try {
      await Promise.all(odfDevices.flatMap((device) => (["front-ports", "rear-ports"] as const).map(async (portType) => {
        const portsUrl = new URL(`${portType}/`, apiBase);
        portsUrl.searchParams.set("device_id", String(device.id));
        portsUrl.searchParams.set("limit", "1000");
        const portsResponse = await fetch(portsUrl, { headers: authHeaders, signal: AbortSignal.timeout(10_000) });
        if (!portsResponse.ok) throw new Error("NetBox front/rear port request failed");
        const portsData = await portsResponse.json() as { results?: OdfPort[] };
        const kind = portType === "front-ports" ? "front" : "rear";
        for (const port of portsData.results ?? []) networkPortsByNode.set(nodeKey(kind, port.id), { port, kind });
      })));
      const connectNodes = (a: string, b: string) => {
        if (!odfLinks.has(a)) odfLinks.set(a, new Set());
        if (!odfLinks.has(b)) odfLinks.set(b, new Set());
        odfLinks.get(a)!.add(b);
        odfLinks.get(b)!.add(a);
      };
      for (const [key, entry] of networkPortsByNode) {
        const { port, kind } = entry;
        if (roleName(deviceById.get(port.device?.id ?? -1)) !== "ODF оператора") continue;
        if (kind === "front") for (const rear of port.rear_ports ?? []) connectNodes(key, nodeKey("rear", rear.rear_port));
        else for (const front of port.front_ports ?? []) connectNodes(key, nodeKey("front", front.front_port));
      }
    } catch {
      return reply.code(502).send({ error: "Не удалось загрузить порты ODF площадки из NetBox." });
    }
    try {
      await Promise.all(bypassDevices.flatMap((device) => (["front-ports", "rear-ports"] as const).map(async (portType) => {
        const portsUrl = new URL(`${portType}/`, apiBase);
        portsUrl.searchParams.set("device_id", String(device.id));
        portsUrl.searchParams.set("limit", "1000");
        const portsResponse = await fetch(portsUrl, { headers: authHeaders, signal: AbortSignal.timeout(10_000) });
        if (!portsResponse.ok) throw new Error("NetBox bypass port request failed");
        const portsData = await portsResponse.json() as { results?: OdfPort[] };
        const kind = portType === "front-ports" ? "front" : "rear";
        for (const port of portsData.results ?? []) networkPortsByNode.set(nodeKey(kind, port.id), { port, kind });
      })));
    } catch {
      request.log.warn({ siteSlug: slug.data, bypassDeviceCount: bypassDevices.length }, "NetBox bypass front/rear port lookup incomplete");
    }

    const progressiveInterfaces: unknown[] = [];
    const matchedBypassFrontPorts = new Set<string>();
    let completedOsDevices = 0;
    const interfaceGroups = await Promise.all(osDevices.map(async (device) => {
      try {
        const interfacesUrl = new URL("interfaces/", apiBase);
        interfacesUrl.searchParams.set("device_id", String(device.id));
        interfacesUrl.searchParams.set("limit", "1000");
        const interfacesResponse = await fetch(interfacesUrl, { headers: authHeaders, signal: AbortSignal.timeout(10_000) });
        if (!interfacesResponse.ok) throw new Error("NetBox interface request failed");
        const interfacesData = await interfacesResponse.json() as { results?: ({ id: number; name: string; cable?: { id?: number; last_updated?: string | null } | null } & LinkedPorts)[] };
        const group = (interfacesData.results ?? []).flatMap((item) => {
          const matches = new Map<string, { host: string; port: string; deviceId: number; interfaceId: number; portKind: "front" | "rear" | null }>();
          const queue: { kind: "front" | "rear"; id: number }[] = [];
          for (const peer of peerList(item)) {
            const peerDevice = peer.device?.id ? deviceById.get(peer.device.id) : undefined;
            const peerKind = endpointKind(peer);
            if (isBypassRole(roleName(peerDevice))) {
              matches.set(`${peerDevice!.id}:${peer.id}`, { host: peerDevice!.name, port: peer.name ?? peer.display ?? "", deviceId: peerDevice!.id, interfaceId: peer.id, portKind: peerKind === "front" || peerKind === "rear" ? peerKind : null });
              if (peerKind === "front") matchedBypassFrontPorts.add(`${peerDevice!.id}:${peer.id}`);
            }
            else if (roleName(peerDevice) === "ODF оператора" && (endpointKind(peer) === "front" || endpointKind(peer) === "rear")) {
              queue.push({ kind: endpointKind(peer) as "front" | "rear", id: peer.id });
            }
          }
          const visited = new Set<string>();
          while (queue.length) {
            const current = queue.shift()!;
            const key = nodeKey(current.kind, current.id);
            if (visited.has(key)) continue;
            visited.add(key);
            const entry = networkPortsByNode.get(key);
            if (!entry) continue;
            for (const peer of peerList(entry.port)) {
              const peerDevice = peer.device?.id ? deviceById.get(peer.device.id) : undefined;
              const peerKind = endpointKind(peer);
              if (isBypassRole(roleName(peerDevice))) {
                matches.set(`${peerDevice!.id}:${peer.id}`, { host: peerDevice!.name, port: peer.name ?? peer.display ?? "", deviceId: peerDevice!.id, interfaceId: peer.id, portKind: peerKind === "front" || peerKind === "rear" ? peerKind : null });
                if (peerKind === "front") matchedBypassFrontPorts.add(`${peerDevice!.id}:${peer.id}`);
              }
              else if (roleName(peerDevice) === "ODF оператора" && (endpointKind(peer) === "front" || endpointKind(peer) === "rear")) {
                const peerKey = nodeKey(endpointKind(peer) as "front" | "rear", peer.id);
                if (!visited.has(peerKey)) queue.push({ kind: endpointKind(peer) as "front" | "rear", id: peer.id });
              }
            }
            for (const neighbor of odfLinks.get(key) ?? []) {
              const [kind, id] = neighbor.split(":") as ["front" | "rear", string];
              if (!visited.has(neighbor)) queue.push({ kind, id: Number(id) });
            }
          }
          const bypasses = [...matches.values()];
          return bypasses.map((bypass, index) => {
            let behind: { deviceId: number; interfaceId: number; device: string; port: string } | null = null;
            let linkTspuId = "";
            if (bypass.portKind) {
              const bypassPortEntry = networkPortsByNode.get(nodeKey(bypass.portKind, bypass.interfaceId));
              if (bypass.portKind === "front") linkTspuId = tspuId(bypassPortEntry?.port.custom_fields);
              else {
                const frontPortIds = bypassPortEntry?.port.front_ports?.map((item) => item.front_port) ?? [];
                linkTspuId = frontPortIds.map((frontPortId) => tspuId(networkPortsByNode.get(nodeKey("front", frontPortId))?.port.custom_fields)).find(Boolean) ?? "";
                for (const frontPortId of frontPortIds) matchedBypassFrontPorts.add(`${bypass.deviceId}:${frontPortId}`);
              }
              const pairedIds = bypassPortEntry
                ? bypass.portKind === "front"
                  ? (bypassPortEntry.port.rear_ports ?? []).map((item) => item.rear_port)
                  : (bypassPortEntry.port.front_ports ?? []).map((item) => item.front_port)
                : [];
              for (const pairedId of pairedIds) {
                const pairedPort = networkPortsByNode.get(nodeKey(bypass.portKind === "front" ? "rear" : "front", pairedId));
                if (!pairedPort) continue;
                const peer = peerList(pairedPort.port).find((candidate) => endpointKind(candidate) === "interface" && candidate.device?.id !== device.id && candidate.device?.id !== bypass.deviceId);
                if (peer) {
                  behind = { deviceId: peer.device?.id ?? 0, interfaceId: peer.id, device: peer.device?.name ?? "", port: peer.name ?? peer.display ?? "" };
                  break;
                }
              }
            }
            return {
            id: `${device.id}-${item.id}-${index}`,
            deviceId: device.id,
            interfaceId: item.id,
            role: roleName(device),
            port: item.name,
            host: device.name,
            cableId: item.cable?.id,
            linkUpdatedAt: item.cable?.last_updated ?? null,
            bypassHost: bypass.host,
            bypassPort: bypass.port,
            tspuId: linkTspuId,
            behindDevice: behind?.device ?? "",
            behindPort: behind?.port ?? "",
            behindInterfaceId: behind?.interfaceId ?? null,
            linkCapacity: ""
          };
          });
        });
        progressiveInterfaces.push(...group);
        completedOsDevices += 1;
            updateProgress(`Найдено ссылок: ${progressiveInterfaces.length} · устройства ОС ${completedOsDevices} из ${osDevices.length}`, 30 + Math.round(55 * completedOsDevices / Math.max(osDevices.length, 1)), [...progressiveInterfaces]);
        return group;
      } catch {
        throw new Error("Не удалось загрузить интерфейсы устройств площадки из NetBox.");
      }
    })).catch(() => null);
    if (!interfaceGroups) return reply.code(502).send({ error: "Не удалось загрузить интерфейсы устройств площадки из NetBox." });

    const interfaces: (typeof interfaceGroups[number][number] & { needsOsCable?: boolean })[] = interfaceGroups.flat();
    for (const [key, entry] of networkPortsByNode) {
      if (entry.kind !== "front") continue;
      const bypassDevice = deviceById.get(entry.port.device?.id ?? -1);
      const id = `${bypassDevice?.id ?? -1}:${entry.port.id}`;
      const linkedTspuId = tspuId(entry.port.custom_fields);
      if (!bypassDevice || !isBypassRole(roleName(bypassDevice)) || !linkedTspuId || peerList(entry.port).length > 0 || matchedBypassFrontPorts.has(id)) continue;
      interfaces.push({
        id: `missing-os-${key.replace(":", "-")}`,
        deviceId: bypassDevice.id,
        interfaceId: entry.port.id,
        role: roleName(bypassDevice),
        port: "Требуется создать кабель в NetBox",
        host: "Требуется создать кабель в NetBox",
        cableId: undefined,
        linkUpdatedAt: null,
        bypassHost: bypassDevice.name,
        bypassPort: entry.port.name,
        tspuId: linkedTspuId,
        behindDevice: "",
        behindPort: "",
        behindInterfaceId: null,
        linkCapacity: "",
        needsOsCable: true
      });
    }
    const behindInterfaceIds = [...new Set(interfaces.flatMap((item) => item.behindInterfaceId ? [item.behindInterfaceId] : []))];
    for (let index = 0; index < behindInterfaceIds.length; index += 20) {
      await Promise.all(behindInterfaceIds.slice(index, index + 20).map(async (interfaceId) => {
        try {
          const interfaceUrl = new URL(`interfaces/${interfaceId}/`, apiBase);
          const interfaceResponse = await fetch(interfaceUrl, { headers: authHeaders, signal: AbortSignal.timeout(10_000) });
          if (!interfaceResponse.ok) return;
          const targetInterface = await interfaceResponse.json() as { type?: { label?: string; value?: string } | null };
          const linkCapacity = targetInterface.type?.label ?? targetInterface.type?.value ?? "";
          for (const item of interfaces) if (item.behindInterfaceId === interfaceId) item.linkCapacity = linkCapacity;
        } catch {
          // Keep the downstream columns available even if interface type cannot be read.
        }
      }));
    }
    const cableIds = [...new Set(interfaces.flatMap((item) => item.linkUpdatedAt || !item.cableId ? [] : [item.cableId]))];
    for (let index = 0; index < cableIds.length; index += 20) {
      await Promise.all(cableIds.slice(index, index + 20).map(async (cableId) => {
        try {
          const cableUrl = new URL(`cables/${cableId}/`, apiBase);
          const cableResponse = await fetch(cableUrl, { headers: authHeaders, signal: AbortSignal.timeout(10_000) });
          if (!cableResponse.ok) return;
          const cable = await cableResponse.json() as { last_updated?: string | null };
          const updatedAt = cable.last_updated ?? null;
          for (const item of interfaces) if (item.cableId === cableId) item.linkUpdatedAt = updatedAt;
        } catch {
          // Keep the table usable when NetBox cannot provide cable timestamps.
        }
      }));
    }
    for (const item of interfaces) delete item.cableId;
    if (interfaces.length === 0) {
      request.log.warn({ siteSlug: slug.data, siteDeviceCount: siteDevices.length, osDeviceCount: osDevices.length, odfDeviceCount: odfDevices.length }, "NetBox site found but no OS-to-bypass links matched");
    }
    interfaces.sort((a, b) =>
      a.bypassHost.localeCompare(b.bypassHost, "ru", { numeric: true, sensitivity: "base" }) ||
      a.bypassPort.localeCompare(b.bypassPort, "ru", { numeric: true, sensitivity: "base" }) ||
      a.host.localeCompare(b.host, "ru", { numeric: true, sensitivity: "base" }) ||
      a.port.localeCompare(b.port, "ru", { numeric: true, sensitivity: "base" })
    );
    updateProgress(`Готово: ${interfaces.length} ссылок`, 100, interfaces, true);
    return {
      found: true,
      site: { id: site.id, name: site.name, slug: site.slug },
      interfaces
    };
  });

  app.get<{ Querystring: { date?: string } }>("/api/daps/daily-kpi", { preHandler: readAccess }, async (request, reply) => {
    const date = parseDate(request.query.date);
    if (!date) return reply.code(400).send({ error: "Укажите дату в формате ГГГГ-ММ-ДД." });
    const daps = await getDapsDatabase(prisma);
    const { sourceSchema, aggregateSchema } = await getDapsSchemas(prisma);
    const sourceTable = Prisma.raw(`${quoteDapsSchema(sourceSchema)}."all_k"`);
    const aggregateTable = Prisma.raw(`${quoteDapsSchema(aggregateSchema)}."Aggregate_for_KPI"`);
    const [tables] = await daps.$queryRaw<{ allK: string | null; aggregate: string | null }[]>`
      SELECT to_regclass(${`${quoteDapsSchema(sourceSchema)}.all_k`})::text AS "allK",
             to_regclass(${`${quoteDapsSchema(aggregateSchema)}."Aggregate_for_KPI"`})::text AS aggregate
    `;
    if (!tables?.allK) {
      return reply.code(424).send({ error: `В подключённой базе не найдена таблица ${sourceSchema}.all_k. Проверьте выбранную схему или создайте таблицу в этой базе.` });
    }
    if (!tables.aggregate) {
      return reply.code(424).send({ error: `В подключённой базе не найдена таблица ${aggregateSchema}.Aggregate_for_KPI. Проверьте выбранную схему или создайте таблицу в этой базе.` });
    }
    const rows = await daps.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      WITH monthly_stats AS (
        SELECT
          AVG("KPI-01") AS avg_kpi_01, AVG("KPI-02") AS avg_kpi_02,
          AVG("KPI-03") AS avg_kpi_03, AVG("KPI-04") AS avg_kpi_04,
          AVG("KPI-05") AS avg_kpi_05, AVG("KPI-06") AS avg_kpi_06,
          AVG("KPI-07") AS avg_kpi_07
        FROM ${sourceTable}
        WHERE date::date >= date_trunc('month', ${date}::date)::date AND date::date <= ${date}::date
      )
      SELECT t.date::date AS date,
        t."KPI-01", t."KPI-02", t."KPI-03", t."KPI-04", t."KPI-05", t."KPI-06", t."KPI-07",
        t."KPI-03(AVR)", t."KPI-03(PNR)",
        m.avg_kpi_01, m.avg_kpi_02, m.avg_kpi_03, m.avg_kpi_04, m.avg_kpi_05, m.avg_kpi_06, m.avg_kpi_07,
        a."KPI-03(CUMM)", a."KPI-0(MM_day)", a."KPI-0(MM_mounth)"
      FROM ${sourceTable} t
      CROSS JOIN monthly_stats m
      LEFT JOIN ${aggregateTable} a ON a."Data"::date = t.date::date
      WHERE t.date::date = ${date}::date
    `);
    const row = rows[0];
    const values = row ? Object.fromEntries([
      ...kpiFields.map((field) => [field, row[field]] as const),
      ["KPI-03(AVR)", row["KPI-03(AVR)"]] as const, ["KPI-03(PNR)", row["KPI-03(PNR)"]] as const,
      ["KPI-03(CUMM)", row["KPI-03(CUMM)"]] as const, ["KPI-0(MM_day)", row["KPI-0(MM_day)"]] as const,
      ["KPI-0(MM_mounth)", row["KPI-0(MM_mounth)"]] as const
    ]) : null;
    const monthlyAverages = row ? Object.fromEntries(kpiFields.map((field, index) => [field, row[`avg_kpi_${String(index + 1).padStart(2, "0")}`]])) : {};
    return {
      date: request.query.date,
      values,
      monthlyAverages,
      monthLabel: date.toLocaleDateString("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" })
    };
  });

  app.get("/api/daps/daily-kpi/chart", { preHandler: readAccess }, async () => {
    const daps = await getDapsDatabase(prisma);
    const { aggregateSchema } = await getDapsSchemas(prisma);
    const aggregateTable = Prisma.raw(`${quoteDapsSchema(aggregateSchema)}."Aggregate_for_KPI"`);
    const rows = await daps.$queryRaw<{ date: Date; values: Record<string, unknown> }[]>(Prisma.sql`
      SELECT "Data"::date AS date,
        jsonb_build_object(
          'KPI-03', "KPI-03", 'KPI-03(AVR)', "KPI-03(AVR)",
          'KPI-03(PNR)', "KPI-03(PNR)", 'KPI-03(CUMM)', "KPI-03(CUMM)"
        ) AS "values"
      FROM ${aggregateTable}
      ORDER BY "Data" ASC
    `);
    return rows.map((row) => ({ date: row.date.toISOString().slice(0, 10), values: row.values }));
  });

  app.put<{ Params: { date: string } }>("/api/daps/daily-kpi/:date", { preHandler: writeAccess }, async (request, reply) => {
    const date = parseDate(request.params.date);
    if (!date) return reply.code(400).send({ error: "Укажите дату в формате ГГГГ-ММ-ДД." });
    const parsed = dailyKpiSaveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Проверьте значения К0 и накопленного К3." });
    const daps = await getDapsDatabase(prisma);
    const { aggregateSchema } = await getDapsSchemas(prisma);
    const aggregateTable = Prisma.raw(`${quoteDapsSchema(aggregateSchema)}."Aggregate_for_KPI"`);
    const updated = await daps.$queryRaw<{ date: Date }[]>(Prisma.sql`
      UPDATE ${aggregateTable}
      SET "KPI-0(MM_day)" = ${String(parsed.data.k0Fact)},
          "KPI-0(MM_mounth)" = ${String(parsed.data.k0Accum)},
          "KPI-03(CUMM)" = ${String(parsed.data.k3Accum)}
      WHERE "Data"::date = ${date}::date
      RETURNING "Data"::date AS date
    `);
    if (!updated.length) return reply.code(404).send({ error: `В таблице ${aggregateSchema}.Aggregate_for_KPI нет строки за эту дату. Сначала добавьте дату в таблицу и повторите сохранение.` });
    await recordLog(prisma, {
      level: "INFO", action: "DAPS_DAILY_KPI_UPDATE",
      message: `Обновлены показатели ежедневного отчёта KPI в ${aggregateSchema}.Aggregate_for_KPI за ${request.params.date}.`,
      actorId: request.sessionUser?.id ?? null, actorLogin: request.sessionUser?.login ?? null,
      actorRole: request.sessionUser?.role ?? null, entityId: request.params.date
    });
    return { date: request.params.date };
  });

}
