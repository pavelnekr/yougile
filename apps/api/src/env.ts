import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
const result = dotenv.config({ path: envFile });

if (result.error && process.env.NODE_ENV !== "production") {
  throw new Error(`Could not load environment file at ${envFile}`, {
    cause: result.error
  });
}
