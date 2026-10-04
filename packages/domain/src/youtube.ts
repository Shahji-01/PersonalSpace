/**
 * YouTube integration (§40, M3 Learning).
 *
 * Handles fetching metadata for YouTube videos and expanding playlists
 * into child learning resources using the YouTube Data API v3.
 */

import { v7 as uuidv7 } from 'uuid';
import { eq, and, isNull } from 'drizzle-orm';
import { learningResources, type Database } from '@personalspace/db';

const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3';

/** Parses a YouTube video ID or playlist ID from a URL. */
export function parseYouTubeId(urlStr: string): { type: 'video' | 'playlist' | null; id: string | null } {
  try {
    const url = new URL(urlStr);
    
    // Check for playlist
    if (url.searchParams.has('list')) {
      return { type: 'playlist', id: url.searchParams.get('list') };
    }
    
    // Check for video (youtube.com/watch?v=...)
    if (url.searchParams.has('v')) {
      return { type: 'video', id: url.searchParams.get('v') };
    }
    
    // Check for shortlink (youtu.be/...)
    if (url.hostname === 'youtu.be') {
      return { type: 'video', id: url.pathname.slice(1) };
    }
    
    // Check for shorts (youtube.com/shorts/...)
    if (url.pathname.startsWith('/shorts/')) {
      return { type: 'video', id: url.pathname.split('/')[2] || null };
    }
  } catch {
    // Ignore invalid URLs
  }
  return { type: null, id: null };
}

/** Fetches basic metadata for a video or playlist via Data API. */
export async function fetchYouTubeMetadata(id: string, type: 'video' | 'playlist', apiKey: string) {
  const endpoint = type === 'video' ? 'videos' : 'playlists';
  const url = `${YOUTUBE_API_URL}/${endpoint}?part=snippet,contentDetails&id=${id}&key=${apiKey}`;
  
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API error: ${res.status}`);
  
  const data = (await res.json()) as any;
  const item = data.items?.[0];
  if (!item) throw new Error(`YouTube ${type} not found`);

  return {
    title: item.snippet.title,
    description: item.snippet.description,
    thumbnailUrl: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
    author: item.snippet.channelTitle,
    durationSeconds: type === 'video' ? parseIsoDuration(item.contentDetails?.duration) : undefined,
  };
}

/** Fetches playlist items and returns them formatted for insertion. */
export async function fetchPlaylistItems(playlistId: string, apiKey: string) {
  const items: any[] = [];
  let nextPageToken = '';
  
  // Cap at 50 items for v1 to avoid huge expansions.
  do {
    const url = `${YOUTUBE_API_URL}/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=50&key=${apiKey}${nextPageToken ? `&pageToken=${nextPageToken}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`YouTube API error: ${res.status}`);
    
    const data = (await res.json()) as any;
    for (const item of data.items || []) {
      items.push({
        videoId: item.snippet.resourceId.videoId,
        title: item.snippet.title,
        description: item.snippet.description,
        thumbnailUrl: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
        author: item.snippet.channelTitle,
        position: item.snippet.position,
      });
    }
    nextPageToken = data.nextPageToken;
  } while (nextPageToken && items.length < 50);

  return items;
}

/** Parses ISO 8601 duration (e.g., PT1H2M10S) to seconds. */
function parseIsoDuration(duration: string | undefined): number {
  if (!duration) return 0;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  return hours * 3600 + minutes * 60 + seconds;
}

/** 
 * Integrates playlist expansion into the database.
 * Creates child learning_resources for each playlist item.
 */
export async function expandPlaylist(db: Database, parentResource: any, YOUTUBE_API_KEY?: string) {
  if (!YOUTUBE_API_KEY) return;
  const { type, id } = parseYouTubeId(parentResource.url);
  if (type !== 'playlist' || !id) return;

  const items = await fetchPlaylistItems(id, YOUTUBE_API_KEY);
  if (!items.length) return;

  const now = new Date();
  const children = items.map((item) => ({
    id: uuidv7(),
    userId: parentResource.userId,
    version: 1,
    url: `https://www.youtube.com/watch?v=${item.videoId}&list=${id}`,
    resourceType: 'youtube_video',
    source: 'automated' as const,
    parentResourceId: parentResource.id,
    positionInParent: item.position,
    collectionId: parentResource.collectionId, // Inherit collection
    title: item.title,
    description: item.description,
    thumbnailUrl: item.thumbnailUrl,
    author: item.author,
    status: 'saved' as const,
    metadataStatus: 'ok' as const,
    metadataFetchedAt: now,
    createdAt: now,
    updatedAt: now,
  }));

  // Insert in chunks of 10 to respect parameters limits if needed, but 50 is fine for Postgres.
  await db.insert(learningResources).values(children).onConflictDoNothing();
}
