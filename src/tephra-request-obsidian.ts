import { requestUrl } from "obsidian";
import type { TephraRequestFn } from "./tephra-client";

/**
 * The production `TephraRequestFn`: Obsidian's `requestUrl`, which isn't subject to the `app://` CORS
 * rules or the preflight an `Authorization` header would trigger on `fetch`. Its own file for the same
 * reason as `api-request-obsidian.ts`: everything else Tephra stays free of a runtime `obsidian` import.
 */
export const obsidianTephraRequest: TephraRequestFn = async ({ url, method, headers, body }) => {
	const response = await requestUrl({ url, method, headers, body, throw: false });
	return { status: response.status, text: response.text };
};
