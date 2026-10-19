import type { FastifyInstance } from "fastify";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireWorkspaceAccess } from "../auth/service.js";
import { recordLog } from "../logs/service.js";
import { getDapsDatabase, getDapsSchemas, quoteDapsSchema } from "./database.js";
import { getNetboxApiSettings } from "./netbox.js";

const kpiFields = ["KPI-01", "KPI-02", "KPI-03", "KPI-04", "KPI-05", "KPI-06", "KPI-07"] as const;
const dailyKpiSaveSchema = z.object({
  k0Fact: z.number().finite(),
  k0Accum: z.number().finite(),
  k3Accum: z.number().finite()
});

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

export async function registerDapsRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const readAccess = requireWorkspaceAccess("DAPS");
  const writeAccess = requireWorkspaceAccess("DAPS", true);

  app.get<{ Querystring: { slug?: string } }>("/api/daps/netbox/site", { preHandler: readAccess }, async (request, reply) => {
    const slug = z.string().trim().min(1).max(100).safeParse(request.query.slug);
    if (!slug.success) return reply.code(400).send({ error: "Введите номер площадки." });
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
    if (!site) return { found: false, site: null, interfaces: [] };

    const apiBase = new URL("/api/dcim/", settings.url);
    let siteDevices: { id: number; name: string; role?: { name?: string } | null }[];
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
    type OdfPort = { id: number; name: string; device?: { id?: number } | null; link_peers?: NetboxPeer[] | null; rear_ports?: { rear_port: number }[]; front_ports?: { front_port: number }[] };
    const deviceById = new Map(siteDevices.map((device) => [device.id, device]));
    const isBypassRole = (role?: string) => role === "Комбинированный байпас" || role === "Пассивный байпас";
    const odfDevices = siteDevices.filter((device) => device.role?.name === "ODF оператора");
    const osDevices = siteDevices.filter((device) => device.role?.name === "Устройство LAN" || device.role?.name === "Устройство WAN");
    const authHeaders = { Authorization: `${settings.tokenType} ${settings.token}`, Accept: "application/json" };
    const odfPortsByNode = new Map<string, { port: OdfPort; kind: "front" | "rear" }>();
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
        if (!portsResponse.ok) throw new Error("NetBox ODF port request failed");
        const portsData = await portsResponse.json() as { results?: OdfPort[] };
        const kind = portType === "front-ports" ? "front" : "rear";
        for (const port of portsData.results ?? []) odfPortsByNode.set(nodeKey(kind, port.id), { port, kind });
      })));
      const connectNodes = (a: string, b: string) => {
        if (!odfLinks.has(a)) odfLinks.set(a, new Set());
        if (!odfLinks.has(b)) odfLinks.set(b, new Set());
        odfLinks.get(a)!.add(b);
        odfLinks.get(b)!.add(a);
      };
      for (const [key, entry] of odfPortsByNode) {
        const { port, kind } = entry;
        if (kind === "front") for (const rear of port.rear_ports ?? []) connectNodes(key, nodeKey("rear", rear.rear_port));
        else for (const front of port.front_ports ?? []) connectNodes(key, nodeKey("front", front.front_port));
      }
    } catch {
      return reply.code(502).send({ error: "Не удалось загрузить порты ODF площадки из NetBox." });
    }

    const interfaceGroups = await Promise.all(osDevices.map(async (device) => {
      try {
        const interfacesUrl = new URL("interfaces/", apiBase);
        interfacesUrl.searchParams.set("device_id", String(device.id));
        interfacesUrl.searchParams.set("limit", "1000");
        const interfacesResponse = await fetch(interfacesUrl, { headers: authHeaders, signal: AbortSignal.timeout(10_000) });
        if (!interfacesResponse.ok) throw new Error("NetBox interface request failed");
        const interfacesData = await interfacesResponse.json() as { results?: { id: number; name: string; link_peers?: NetboxPeer[] | null }[] };
        return (interfacesData.results ?? []).flatMap((item) => {
          const matches = new Map<string, { host: string; port: string }>();
          const queue: { kind: "front" | "rear"; id: number }[] = [];
          for (const peer of item.link_peers ?? []) {
            const peerDevice = peer.device?.id ? deviceById.get(peer.device.id) : undefined;
            if (isBypassRole(peerDevice?.role?.name)) matches.set(`${peerDevice!.id}:${peer.id}`, { host: peerDevice!.name, port: peer.name ?? peer.display ?? "" });
            else if (peerDevice?.role?.name === "ODF оператора" && (endpointKind(peer) === "front" || endpointKind(peer) === "rear")) {
              queue.push({ kind: endpointKind(peer) as "front" | "rear", id: peer.id });
            }
          }
          const visited = new Set<string>();
          while (queue.length) {
            const current = queue.shift()!;
            const key = nodeKey(current.kind, current.id);
            if (visited.has(key)) continue;
            visited.add(key);
            const entry = odfPortsByNode.get(key);
            if (!entry) continue;
            for (const peer of entry.port.link_peers ?? []) {
              const peerDevice = peer.device?.id ? deviceById.get(peer.device.id) : undefined;
              if (isBypassRole(peerDevice?.role?.name)) matches.set(`${peerDevice!.id}:${peer.id}`, { host: peerDevice!.name, port: peer.name ?? peer.display ?? "" });
              else if (peerDevice?.role?.name === "ODF оператора" && (endpointKind(peer) === "front" || endpointKind(peer) === "rear")) {
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
          return bypasses.map((bypass, index) => ({
            id: `${device.id}-${item.id}-${index}`,
            role: device.role?.name ?? "",
            port: item.name,
            host: device.name,
            bypassHost: bypass.host,
            bypassPort: bypass.port
          }));
        });
      } catch {
        throw new Error("Не удалось загрузить интерфейсы устройств площадки из NetBox.");
      }
    })).catch(() => null);
    if (!interfaceGroups) return reply.code(502).send({ error: "Не удалось загрузить интерфейсы устройств площадки из NetBox." });

    return {
      found: true,
      site: { id: site.id, name: site.name, slug: site.slug },
      interfaces: interfaceGroups.flat().sort((a, b) =>
        a.bypassHost.localeCompare(b.bypassHost, "ru", { numeric: true, sensitivity: "base" }) ||
        a.bypassPort.localeCompare(b.bypassPort, "ru", { numeric: true, sensitivity: "base" }) ||
        a.host.localeCompare(b.host, "ru", { numeric: true, sensitivity: "base" }) ||
        a.port.localeCompare(b.port, "ru", { numeric: true, sensitivity: "base" })
      )
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
