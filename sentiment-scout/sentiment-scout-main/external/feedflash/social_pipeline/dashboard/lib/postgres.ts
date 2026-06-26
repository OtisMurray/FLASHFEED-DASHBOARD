import { neon } from "@neondatabase/serverless";

export function getSQL() {
  return neon(process.env.POSTGRES_DSN!);
}
