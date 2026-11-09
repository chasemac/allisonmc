import { main } from "../lib/cli.js";

const code = await main(process.argv.slice(2), process.env);
process.exit(code);
