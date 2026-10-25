import { Router } from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { streamToString } from "../utils/stream.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load repo-root env before reading JSON_BUCKET_NAME. ESM imports this
// module before server.js dotenv.config() runs, and cwd-relative "../.env"
// misses .env.local when the process is started from backend/.
dotenv.config({ path: path.join(__dirname, "../../.env.local") });
dotenv.config({ path: path.join(__dirname, "../../.env") });

const router = Router();

// ─── Config ───────────────────────────────────────────────────────────────────

const FIRST_YEAR = 2021;

const envSeasonYear = parseInt(process.env.SEASON_YEAR, 10);
const runtimeYear = new Date().getFullYear();
const CURRENT_YEAR = Number.isFinite(envSeasonYear)
  ? Math.max(envSeasonYear, runtimeYear)
  : runtimeYear;

const BUCKET_NAME = process.env.JSON_BUCKET_NAME;
if (!BUCKET_NAME) {
  console.warn(
    "[league] JSON_BUCKET_NAME env var is missing. Standings and leaders routes will return 503 until it is set.",
  );
}

// ─── S3 Client ────────────────────────────────────────────────────────────────

// Uses explicit credentials in local dev, falls back to ECS task role in production.
const s3Config = { region: process.env.AWS_REGION || "us-east-2" };

const hasExplicitCredentials =
  process.env.AWS_ACCESS_KEY?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim();

if (hasExplicitCredentials) {
  console.info("[league] Using explicit AWS credentials from environment variables.");
  s3Config.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  };
} else if (process.env.AWS_PROFILE) {
  console.info("[league] Using the local AWS profile to read the deployed data bucket.");
  s3Config.credentials = defaultProvider({ profile: process.env.AWS_PROFILE });
} else {
  console.info("[league] Using ECS task role for AWS credentials.");
}

const s3 = new S3Client(s3Config);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch and parse a JSON file from S3.
 * Throws on any error — callers handle 404 vs 500 distinction.
 */
function requireBucket(res) {
  if (BUCKET_NAME) return true;
  res.status(503).json({
    success: false,
    message: "League data is unavailable: JSON_BUCKET_NAME is not configured.",
  });
  return false;
}

async function fetchS3Json(key) {
  const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
  const response = await s3.send(command);
  const text = await streamToString(response.Body);
  return JSON.parse(text);
}

/**
 * Central S3 error handler. Distinguishes missing keys (404) from other failures (500).
 */
function handleS3Error(error, res, context) {
  const isNotFound = error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404;
  console.error(`[league] ${context} — ${isNotFound ? "key not found" : "unexpected error"}:`, error);

  if (isNotFound) {
    return res.status(404).json({ success: false, message: error._notFoundMessage ?? "Data not found." });
  }

  const isDenied =
    error.name === "AccessDenied" ||
    error.name === "CredentialsProviderError" ||
    error.$metadata?.httpStatusCode === 403;
  if (isDenied) {
    return res.status(503).json({
      success: false,
      message: `League data is unavailable: no AWS permission to read s3://${BUCKET_NAME}. Set AWS_ACCESS_KEY and AWS_SECRET_ACCESS_KEY for local development.`,
    });
  }

  return res.status(500).json({ success: false, message: "An unexpected error occurred." });
}

/**
 * Validate and parse a year query param, falling back to CURRENT_YEAR.
 * Returns null and sends a 400 if the value is present but invalid.
 */
function resolveYear(queryYear, res) {
  if (!queryYear) return CURRENT_YEAR;
  const parsed = parseInt(queryYear, 10);
  if (!Number.isFinite(parsed) || parsed < FIRST_YEAR || parsed > CURRENT_YEAR) {
    res.status(400).json({
      success: false,
      message: `Invalid year. Must be between ${FIRST_YEAR} and ${CURRENT_YEAR}.`,
    });
    return null;
  }
  return parsed;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /league/seasons
 * Returns the list of available seasons, newest first.
 */
router.get("/seasons", (req, res) => {
  const seasons = [];
  for (let y = CURRENT_YEAR; y >= FIRST_YEAR; y--) {
    seasons.push({
      year: String(y),
      label: y === CURRENT_YEAR ? `${y} (Current)` : String(y),
      isCurrent: y === CURRENT_YEAR,
    });
  }

  return res.status(200).json({
    success: true,
    message: "Fetched available seasons.",
    data: { seasons, currentYear: String(CURRENT_YEAR) },
  });
});

/**
 * GET /league/standings?year=YYYY&half=first|full
 * Returns standings data for the requested season.
 * When half=first, loads the frozen first-half snapshot if available.
 */
router.get("/standings", async (req, res) => {
  if (!requireBucket(res)) return;
  const year = resolveYear(req.query.year, res);
  if (year === null) return;

  const half = req.query.half === "first" ? "first" : "full";
  const key = half === "first"
    ? `standings/${year}-first-half-standings.json`
    : `standings/${year}-standings.json`;

  try {
    const data = await fetchS3Json(key);
    return res.status(200).json({
      success: true,
      message: "Fetched season standings successfully.",
      data,
    });
  } catch (error) {
    error._notFoundMessage = half === "first"
      ? `First-half standings are not yet available for the ${year} season.`
      : `No standings data available for the ${year} season.`;
    return handleS3Error(error, res, `standings(${year},${half})`);
  }
});

/**
 * GET /league/leaders?year=YYYY
 * Returns league leaders data for the requested season.
 */
router.get("/leaders", async (req, res) => {
  if (!requireBucket(res)) return;
  const year = resolveYear(req.query.year, res);
  if (year === null) return;

  try {
    const data = await fetchS3Json(`league-leaders/${year}-league-leaders.json`);
    return res.status(200).json({
      success: true,
      message: "Fetched league leaders successfully.",
      data,
    });
  } catch (error) {
    error._notFoundMessage = `No stat leaders data available for the ${year} season.`;
    return handleS3Error(error, res, `leaders(${year})`);
  }
});

export default router;