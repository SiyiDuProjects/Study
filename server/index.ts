import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServerApp } from "./app.js";
import { openDatabase } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3001);
const staticDir = process.env.JIAHUAN_STATIC_DIR ?? path.resolve(__dirname, "../../dist");
const db = openDatabase();
const app = createServerApp({ db, staticDir });

app.listen(port, "0.0.0.0", () => {
  console.log(`Jiahuan app listening on ${port}`);
});
