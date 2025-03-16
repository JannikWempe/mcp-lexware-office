import { logger } from "./logger.js";

const LEXWARE_OFFICE_API_KEY = process.env.LEXWARE_OFFICE_API_KEY!;
if (!LEXWARE_OFFICE_API_KEY) {
  logger.error(
    "Error: LEXWARE_OFFICE_API_KEY environment variable is required"
  );
  process.exit(1);
}

const LEXOFFICE_API_BASE = "https://api.lexoffice.io";
const USER_AGENT = "lexoffice-mcp/0.1.0";

// Helper function for making NWS API requests
export async function makeLexOfficeRequest<T>(path: string): Promise<T | null> {
  const url = `${LEXOFFICE_API_BASE}${path}`;
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    Authorization: `Bearer ${LEXWARE_OFFICE_API_KEY}`,
  };

  logger.log("Making LexOffice request", {
    url,
  });

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const json = await response.json();
    logger.log("LexOffice response", { json });
    return json as T;
  } catch (error) {
    logger.error("Error making LexOffice request", { error });
    return null;
  }
}
