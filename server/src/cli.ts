import { configurationFromEnvironment, startServer } from "./index";

startServer(configurationFromEnvironment(process.env)).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
