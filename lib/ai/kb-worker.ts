// lib/ai/kb-worker.ts
// Knowledge Base worker: keyword search over Argus KB markdown files
// No LLM calls — simple text matching with section extraction

import * as fs from "fs";
import * as path from "path";

const KB_DIR = path.resolve(process.cwd(), "data", "kb");

interface KBSection {
  file: string;
  heading: string;
  content: string;
  score: number;
}

// Cache loaded KB files in memory (they're small, ~90KB total)
let kbCache: { file: string; content: string }[] | null = null;

function loadKBFiles(): { file: string; content: string }[] {
  if (kbCache) return kbCache;

  try {
    const files = fs.readdirSync(KB_DIR).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
    kbCache = files.map((f) => ({
      file: f,
      content: fs.readFileSync(path.join(KB_DIR, f), "utf-8"),
    }));
    console.log(`[KB] Loaded ${kbCache.length} knowledge base files from ${KB_DIR}`);
  } catch {
    console.warn(`[KB] Could not read KB directory: ${KB_DIR}`);
    kbCache = [];
  }
  return kbCache;
}

/**
 * Invalidate the KB cache so files are re-read on next search.
 */
export function reloadKB(): void {
  kbCache = null;
  console.log("[KB] Cache invalidated — will reload on next search");
}

// Watch data/kb/ for changes and auto-invalidate cache
let watcherInitialized = false;

function initWatcher() {
  if (watcherInitialized) return;
  watcherInitialized = true;

  try {
    if (!fs.existsSync(KB_DIR)) return;

    fs.watch(KB_DIR, { persistent: false }, (eventType, filename) => {
      if (filename && filename.endsWith(".md")) {
        console.log(`[KB] Detected ${eventType} on ${filename} — reloading cache`);
        reloadKB();
      }
    });
    console.log(`[KB] Watching ${KB_DIR} for changes`);
  } catch (err) {
    console.warn("[KB] Could not set up file watcher:", err);
  }
}

// Initialize watcher on module load
initWatcher();

// Split a markdown file into sections by headings
function splitSections(file: string, content: string): KBSection[] {
  const lines = content.split("\n");
  const sections: KBSection[] = [];
  let currentHeading = file;
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.match(/^#{1,3}\s+/)) {
      // Save previous section
      if (currentLines.length > 0) {
        sections.push({
          file,
          heading: currentHeading,
          content: currentLines.join("\n").trim(),
          score: 0,
        });
      }
      currentHeading = line.replace(/^#+\s+/, "").trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Last section
  if (currentLines.length > 0) {
    sections.push({
      file,
      heading: currentHeading,
      content: currentLines.join("\n").trim(),
      score: 0,
    });
  }

  return sections;
}

// Alias map: common terms → Argus-specific keywords the LLM might not guess
const KEYWORD_ALIASES: Record<string, string[]> = {
  "timeout": ["socket_timeout", "ems_tsemp_socket_timeout", "NoResponseFromElement", "communication timeout"],
  "not responding": ["NoResponseFromElement", "ALARM_NORESPONSE", "NON_RESPONSIVE", "RetriesUsedUp"],
  "device down": ["NoResponseFromElement", "ALARM_NORESPONSE", "NON_RESPONSIVE"],
  "retry": ["RetriableCommunicationError", "RetriesUsedUp", "pollRetries"],
  "map": ["Luminato", "VDM", "topology", "element"],
  "alarm": ["ALARM_NORESPONSE", "ALARM_COMMUNICATION", "event", "HMS"],
  "snmp": ["SnmpPduSender", "SnmpElementHelper", "HMS", "OID"],
  "poll": ["ElementPollTask", "StatusPollSubtask", "DataPollSubtask", "pollInterval"],
  "luminato": ["WebClientResponseException", "LuminatoApi", "HTTP", "REST"],
  "vdm": ["VdmGateway", "RPD", "WebClientResponseException"],
  "queue": ["ElementMessageQueue", "MessageQueueCleaner", "MessageResponses"],
  "webclient": ["WebClientResponseException", "Luminato", "VDM", "HTTP", "REST"],
  "parameter": ["ParameterType", "TSEMP", "mapped message", "property"],
  "registration": ["ElementRegistration", "discovery", "newElement"],
  "connection": ["NoResponseFromElement", "socket_timeout", "RetriableCommunicationError"],
};

function expandKeywords(keywords: string[]): string[] {
  const expanded = new Set(keywords);
  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    for (const [alias, extras] of Object.entries(KEYWORD_ALIASES)) {
      if (kwLower.includes(alias) || alias.includes(kwLower)) {
        for (const e of extras) expanded.add(e);
      }
    }
  }
  return Array.from(expanded);
}

// Score a section against keywords
function scoreSection(section: KBSection, keywords: string[]): number {
  const text = (section.heading + " " + section.content).toLowerCase();
  let score = 0;

  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    // Heading match = 3 points
    if (section.heading.toLowerCase().includes(kwLower)) score += 3;
    // Count occurrences in content
    const regex = new RegExp(kwLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const matches = text.match(regex);
    if (matches) score += matches.length;
  }

  return score;
}

/**
 * Search KB files for relevant sections based on keywords.
 * Returns top N matching sections with their content.
 */
export function searchKB(
  keywords: string[],
  maxSections: number = 5,
  maxCharsPerSection: number = 1500
): { sections: KBSection[]; totalChars: number } {
  if (!keywords || keywords.length === 0) {
    return { sections: [], totalChars: 0 };
  }

  const expanded = expandKeywords(keywords);
  const files = loadKBFiles();
  const allSections: KBSection[] = [];

  for (const { file, content } of files) {
    const sections = splitSections(file, content);
    for (const section of sections) {
      section.score = scoreSection(section, expanded);
      if (section.score > 0) {
        allSections.push(section);
      }
    }
  }

  // Sort by score descending, take top N
  allSections.sort((a, b) => b.score - a.score);
  const top = allSections.slice(0, maxSections);

  // Truncate content
  let totalChars = 0;
  for (const section of top) {
    if (section.content.length > maxCharsPerSection) {
      section.content = section.content.slice(0, maxCharsPerSection) + "...";
    }
    totalChars += section.content.length;
  }

  return { sections: top, totalChars };
}

/**
 * Format KB results for inclusion in the synthesizer prompt.
 */
export function formatKBResults(sections: KBSection[]): string {
  if (sections.length === 0) return "";

  return sections
    .map(
      (s) =>
        `--- KB: ${s.file} > ${s.heading} ---\n${s.content}`
    )
    .join("\n\n");
}
