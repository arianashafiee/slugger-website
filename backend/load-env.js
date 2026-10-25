/**
 * Local development uses the same Cognito and session settings as the
 * deployed ECS task, loaded from SSM, and a database on this machine.
 * Production already receives these values from the task definition.
 */
import dotenv from "dotenv";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PARAMETER_MAP = {
  "/slugger/cognito-app-client-id": "COGNITO_APP_CLIENT_ID",
  "/slugger/cognito-user-pool-id": "COGNITO_USER_POOL_ID",
  "/slugger/cognito-app-client-id-public": "NEXT_PUBLIC_COGNITO_APP_CLIENT_ID",
  "/slugger/session-secret": "SESSION_SECRET",
  "/slugger/jwt-secret": "JWT_SECRET",
  "/slugger/token-secret": "TOKEN_SECRET",
  "/slugger/lambda-api-base-url": "LAMBDA_API_BASE_URL",
  "/slugger/json-bucket-name": "JSON_BUCKET_NAME",
  "/slugger/usage-plan-id": "USAGE_PLAN_ID",
};

const REQUIRED_KEYS = [
  "COGNITO_APP_CLIENT_ID",
  "COGNITO_USER_POOL_ID",
  "SESSION_SECRET",
  "JWT_SECRET",
  "TOKEN_SECRET",
];

function isDeployedProduction() {
  return process.env.NODE_ENV === "production" && process.env.LOCAL_DEV !== "true";
}

function isTestProcess() {
  return (
    Boolean(process.env.NODE_TEST_CONTEXT) ||
    process.execArgv.includes("--test") ||
    process.argv.includes("--test")
  );
}

function loadDotenvFiles() {
  const localPath = path.join(rootDir, ".env.local");
  if (existsSync(localPath)) {
    dotenv.config({ path: localPath });
    return;
  }
  const envPath = path.join(rootDir, ".env");
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

function ensureAwsProfile() {
  if (process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY) {
    process.env.AWS_SDK_LOAD_CONFIG = process.env.AWS_SDK_LOAD_CONFIG || "1";
    return;
  }
  try {
    const config = readFileSync(path.join(homedir(), ".aws", "config"), "utf8");
    const profiles = [...config.matchAll(/^\[profile ([^\]]+)\]/gm)].map((match) => match[1]);
    if (profiles.length === 1) {
      process.env.AWS_PROFILE = profiles[0];
      process.env.AWS_SDK_LOAD_CONFIG = "1";
    }
  } catch {
    // Cognito calls fall back to the default AWS credential chain.
  }
}

function missingKeys() {
  return REQUIRED_KEYS.filter((key) => !process.env[key]);
}

function fetchDeployedParameters() {
  const args = [
    "ssm",
    "get-parameters",
    "--names",
    ...Object.keys(PARAMETER_MAP),
    "--with-decryption",
    "--region",
    "us-east-2",
    "--output",
    "json",
  ];
  if (process.env.AWS_PROFILE) {
    args.push("--profile", process.env.AWS_PROFILE);
  }
  const raw = execFileSync("aws", args, { encoding: "utf8" });
  const parsed = JSON.parse(raw);
  if (parsed.InvalidParameters?.length) {
    throw new Error(`Missing SSM parameters: ${parsed.InvalidParameters.join(", ")}`);
  }
  for (const parameter of parsed.Parameters ?? []) {
    const key = PARAMETER_MAP[parameter.Name];
    if (key && !process.env[key]) {
      process.env[key] = parameter.Value;
    }
  }
}

function applyLocalDefaults() {
  process.env.LOCAL_DEV = "true";
  process.env.AWS_REGION = process.env.AWS_REGION || "us-east-2";
  process.env.FRONTEND_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:3001";
  if (process.env.USE_PROD_DB === "true") return;
  process.env.DB_HOST = "localhost";
  process.env.DB_PORT = "5432";
  process.env.DB_USERNAME = "postgres";
  process.env.DB_USER = "postgres";
  process.env.DB_PASSWORD = "localpassword";
  process.env.DB_NAME = "slugger_local";
}

function quoteEnv(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function writeEnvFiles() {
  const localLines = [
    "LOCAL_DEV=true",
    "AWS_REGION=us-east-2",
    `FRONTEND_URL=${quoteEnv(process.env.FRONTEND_URL)}`,
    `NEXT_PUBLIC_API_URL=${quoteEnv(process.env.NEXT_PUBLIC_API_URL)}`,
    `DB_HOST=${quoteEnv(process.env.DB_HOST)}`,
    `DB_PORT=${quoteEnv(process.env.DB_PORT)}`,
    `DB_USERNAME=${quoteEnv(process.env.DB_USERNAME)}`,
    `DB_PASSWORD=${quoteEnv(process.env.DB_PASSWORD)}`,
    `DB_NAME=${quoteEnv(process.env.DB_NAME)}`,
    ...Object.values(PARAMETER_MAP).map((key) => `${key}=${quoteEnv(process.env[key] || "")}`),
    "",
  ];
  writeFileSync(path.join(rootDir, ".env.local"), localLines.join("\n"), { mode: 0o600 });

  const frontendLines = [
    `NEXT_PUBLIC_API_URL=${quoteEnv(process.env.NEXT_PUBLIC_API_URL)}`,
    `NEXT_PUBLIC_COGNITO_APP_CLIENT_ID=${quoteEnv(process.env.NEXT_PUBLIC_COGNITO_APP_CLIENT_ID || process.env.COGNITO_APP_CLIENT_ID || "")}`,
    "",
  ];
  writeFileSync(path.join(rootDir, "frontend", ".env.local"), frontendLines.join("\n"), { mode: 0o600 });
}

export function prepareLocalEnv() {
  if (isDeployedProduction() || isTestProcess()) return;
  loadDotenvFiles();
  ensureAwsProfile();
  const shouldFetch = missingKeys().length > 0;
  if (shouldFetch) {
    fetchDeployedParameters();
  }
  const stillMissing = missingKeys();
  if (stillMissing.length) {
    throw new Error(
      `Local sign-in needs ${stillMissing.join(", ")}. Sign in with aws sso login, then start the app again.`,
    );
  }
  applyLocalDefaults();
  if (shouldFetch || !existsSync(path.join(rootDir, "frontend", ".env.local"))) {
    writeEnvFiles();
  }
}

prepareLocalEnv();
