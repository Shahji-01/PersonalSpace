/**
 * Metadata extractor and safe URL fetcher (§41, M3 Learning).
 *
 * Scrapes OpenGraph/Twitter tags for title, description, and thumbnail.
 * Implements basic SSRF protection (rejecting obvious local IPs) and
 * bounds response size to 1MB.
 */

import { eq, and, lte, isNull } from 'drizzle-orm';
import { learningResources, type Database } from '@personalspace/db';

interface ExtractedMetadata {
  title?: string;
  description?: string;
  thumbnailUrl?: string;
}

const LOCAL_IPS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^[fF][cCdD]/, // IPv6 Unique Local Address
  /^fe80:/i, // IPv6 Link Local
];

function isSafeUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname;
    // Reject localhost, local IPs.
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return false;
    if (LOCAL_IPS.some((regex) => regex.test(host))) return false;
    return true;
  } catch {
    return false;
  }
}

/** Fetch a URL safely and extract basic OpenGraph/Meta tags. */
export async function extractMetadata(urlStr: string): Promise<ExtractedMetadata> {
  if (!isSafeUrl(urlStr)) {
    throw new Error('Unsafe URL');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    const response = await fetch(urlStr, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'PersonalSpaceBot/1.0',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      throw new Error('Not HTML');
    }

    // Limit read to 1MB
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No body reader');

    let html = '';
    let bytesRead = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        bytesRead += value.length;
        html += new TextDecoder('utf-8').decode(value, { stream: true });
        if (bytesRead > 1024 * 1024) {
          // Break early if we exceed 1MB, we likely have the head already.
          break;
        }
      }
    }

    const meta: ExtractedMetadata = {};

    // Very naive regex parsing for meta tags, optimized for standard OG/Twitter tags
    const metaRegex = /<meta\s+(?:[^>]*\s+)?(?:name|property)=["']([^"']+)["']\s+(?:[^>]*\s+)?content=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = metaRegex.exec(html)) !== null) {
      const key = match[1]?.toLowerCase();
      const value = match[2];
      if (!value) continue;

      if ((key === 'og:title' || key === 'twitter:title') && !meta.title) {
        meta.title = decodeHtmlEntities(value);
      } else if ((key === 'og:description' || key === 'twitter:description' || key === 'description') && !meta.description) {
        meta.description = decodeHtmlEntities(value);
      } else if ((key === 'og:image' || key === 'twitter:image') && !meta.thumbnailUrl) {
        meta.thumbnailUrl = value;
      }
    }

    // Fallback title to <title>
    if (!meta.title) {
      const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
      if (titleMatch?.[1]) {
        meta.title = decodeHtmlEntities(titleMatch[1].trim());
      }
    }

    return meta;
  } finally {
    clearTimeout(timeoutId);
  }
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Worker job to process all 'pending' metadata resources.
 * Returns the number of resources processed.
 */
export async function processPendingMetadata(db: Database): Promise<number> {
  const pending = await db
    .select({ id: learningResources.id, url: learningResources.url, title: learningResources.title })
    .from(learningResources)
    .where(and(eq(learningResources.metadataStatus, 'pending'), isNull(learningResources.deletedAt)))
    .limit(50); // Batch size

  let count = 0;
  for (const resource of pending) {
    if (!resource.url) {
      await db
        .update(learningResources)
        .set({ metadataStatus: 'failed', metadataFetchedAt: new Date() })
        .where(eq(learningResources.id, resource.id));
      continue;
    }

    try {
      const meta = await extractMetadata(resource.url);
      
      const patch: any = {
        metadataStatus: 'ok',
        metadataFetchedAt: new Date(),
        updatedAt: new Date(),
      };
      // Only overwrite if the current value is missing or matches the URL (meaning user hasn't explicitly renamed it yet).
      if (meta.title && (resource.title === resource.url || resource.title === '')) {
        patch.title = meta.title.slice(0, 255);
      }
      if (meta.description) patch.description = meta.description.slice(0, 1000);
      if (meta.thumbnailUrl) patch.thumbnailUrl = meta.thumbnailUrl.slice(0, 2048);

      await db
        .update(learningResources)
        .set(patch)
        .where(eq(learningResources.id, resource.id));
    } catch (e) {
      await db
        .update(learningResources)
        .set({ metadataStatus: 'failed', metadataFetchedAt: new Date() })
        .where(eq(learningResources.id, resource.id));
    }
    count++;
  }

  return count;
}
