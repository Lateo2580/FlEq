import { resolve } from "node:path";

type AppConfig = Readonly<{
  appName: string;
  legacyAppName: string;
  stateDirectory: string;
  legacyStateDirectory: string;
  diagnosticDirectory: string;
}>;

function validateAppConfig(config: AppConfig): AppConfig {
  if (config.appName.trim() === "" || config.legacyAppName.trim() === "")
    throw new Error("appName must not be empty");
  if (config.appName === config.legacyAppName)
    throw new Error("new and legacy appName must differ");
  const stateDirectory = resolve(config.stateDirectory);
  const legacyStateDirectory = resolve(config.legacyStateDirectory);
  const diagnosticDirectory = resolve(config.diagnosticDirectory);
  if (stateDirectory === legacyStateDirectory || diagnosticDirectory === legacyStateDirectory)
    throw new Error("new and legacy directories must differ");
  return { ...config, stateDirectory, legacyStateDirectory, diagnosticDirectory };
}

export { validateAppConfig };
export type { AppConfig };
