/**
 * Anchor Edit — LLM-friendly file editing with anchor-based location
 *
 * Replaces the built-in `edit` tool with an anchor-based approach that is
 * more natural for LLMs: instead of requiring exact text matching of the
 * content being replaced, the LLM identifies distinctive "anchor" lines
 * that bracket the target region.
 *
 * Key advantages over the built-in edit tool:
 * 1. Anchors only need to be unique, not exact matches of replaced content
 * 2. No need to reproduce exact whitespace of old code
 * 3. Cleaner mental model: "replace everything between line A and line B"
 * 4. Supports single-line replacement, range replacement, insert-before/after
 * 5. Multi-edit: all edits matched against original file content
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { access, readFile, writeFile } from "fs/promises";
import { constants } from "fs";
import { resolve, isAbsolute } from "path";
import { homedir } from "os";
import * as Diff from "diff";

// ─── Schema ────────────────────────────────────────────────────────────────

const anchorEditSchema = Type.Object({
  path: Type.String({
    description: "Path to the file to edit (relative or absolute)",
  }),
  edits: Type.Array(
    Type.Object(
      {
        start: Type.String({
          description:
            "Anchor text that identifies the start of the edit region. " +
            "Must match a line (or part of a line) in the file. " +
            'Use "__FILE_BEGIN__" to reference the start of the file. ' +
            'Use "__FILE_END__" to reference the end of the file.',
        }),
        end: Type.Optional(
          Type.String({
            description:
              "Anchor text that marks the end of the edit region. " +
              "When omitted, only the line matching `start` is affected. " +
              'Use "__FILE_END__" to reference the end of the file.',
          })
        ),
        newText: Type.String({
          description:
            "The new text to replace the region with. " +
            "Use an empty string to delete the region.",
        }),
        inclusiveStart: Type.Optional(
          Type.Boolean({
            description:
              "Whether the start anchor line is part of the replaced region. " +
              "Default: true when `end` is omitted (single-line replace), " +
              "false when `end` is provided (replace between anchors).",
          })
        ),
        inclusiveEnd: Type.Optional(
          Type.Boolean({
            description:
              "Whether the end anchor line is part of the replaced region. " +
              "Default: false.",
          })
        ),
        occurrence: Type.Optional(
          Type.Number({
            description:
              "Which occurrence of the anchor to use (1-indexed). " +
              "Required when the anchor text appears more than once in the file. " +
              "Applies to both start and end anchors unless startOccurrence/endOccurrence are specified.",
          })
        ),
        startOccurrence: Type.Optional(
          Type.Number({
            description:
              "Which occurrence of the start anchor to use (1-indexed). " +
              "Overrides `occurrence` for the start anchor only.",
          })
        ),
        endOccurrence: Type.Optional(
          Type.Number({
            description:
              "Which occurrence of the end anchor to use (1-indexed). " +
              "Overrides `occurrence` for the end anchor only.",
          })
        ),
      },
      { additionalProperties: false }
    ),
    {
      description:
        "One or more anchor-based edit operations. All edits are matched " +
        "against the original file, not after earlier edits are applied. " +
        "When multiple edits affect the same region, merge them into one edit.",
    }
  ),
});

// ─── Anchor Matching ───────────────────────────────────────────────────────

interface AnchorMatch {
  /** 0-based line index */
  lineIndex: number;
  /** The full line text */
  line: string;
}

interface AnchoredEdit {
  editIndex: number;
  startLine: number; // 0-based, inclusive
  endLine: number; // 0-based, inclusive (the last line of the region)
  newText: string;
}

/**
 * Find lines containing the anchor text.
 * Supports partial line matching and occurrence disambiguation.
 */
function findAnchorLines(
  lines: string[],
  anchor: string,
  occurrence?: number
): AnchorMatch[] {
  // Handle special markers
  if (anchor === "__FILE_BEGIN__") {
    return [{ lineIndex: -1, line: "" }]; // before first line
  }
  if (anchor === "__FILE_END__") {
    return [{ lineIndex: lines.length, line: "" }]; // after last line
  }

  const matches: AnchorMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(anchor)) {
      matches.push({ lineIndex: i, line: lines[i] });
      // If caller wants a specific occurrence, stop early
      if (occurrence !== undefined && matches.length >= occurrence) {
        break;
      }
    }
  }

  // If exact substring match fails, try case-insensitive
  if (matches.length === 0) {
    const lowerAnchor = anchor.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(lowerAnchor)) {
        matches.push({ lineIndex: i, line: lines[i] });
        if (occurrence !== undefined && matches.length >= occurrence) {
          break;
        }
      }
    }
  }

  // If still no match, try fuzzy (normalize whitespace)
  if (matches.length === 0) {
    const fuzzyAnchor = normalizeForFuzzyMatch(anchor);
    for (let i = 0; i < lines.length; i++) {
      if (normalizeForFuzzyMatch(lines[i]).includes(fuzzyAnchor)) {
        matches.push({ lineIndex: i, line: lines[i] });
        if (occurrence !== undefined && matches.length >= occurrence) {
          break;
        }
      }
    }
  }

  return matches;
}

/**
 * Normalize text for fuzzy matching.
 * Strips trailing whitespace, normalizes Unicode quotes/dashes/spaces.
 */
function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

// ─── Line Ending Handling ──────────────────────────────────────────────────

function detectLineEnding(text: string): "\r\n" | "\n" {
  const crlfIdx = text.indexOf("\r\n");
  const lfIdx = text.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

// ─── BOM Handling ──────────────────────────────────────────────────────────

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

// ─── Uniqueness Check ──────────────────────────────────────────────────────

function checkAnchorUnique(
  matches: AnchorMatch[],
  anchor: string,
  occurrence: number | undefined,
  editIndex: number,
  path: string
): AnchorMatch {
  if (matches.length === 0) {
    throw new Error(
      `Could not find anchor "${truncateForError(anchor)}" in ${path}. ` +
        `Check that the anchor text matches a line (or part of a line) in the file.`
    );
  }

  if (occurrence !== undefined) {
    if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > matches.length) {
      const reason = !Number.isInteger(occurrence)
        ? `${occurrence} is not a valid occurrence (must be a positive integer)`
        : `has ${matches.length} occurrence(s), but edits[${editIndex}] requested occurrence ${occurrence}`;
      throw new Error(
        `Anchor "${truncateForError(anchor)}" ${reason}.`
      );
    }
    return matches[occurrence - 1];
  }

  if (matches.length > 1) {
    const previews = matches
      .slice(0, 5)
      .map((m, i) => `  [${i + 1}] line ${m.lineIndex + 1}: ${truncateForError(m.line.trim())}`)
      .join("\n");
    const extra = matches.length > 5 ? `\n  ... and ${matches.length - 5} more` : "";
    throw new Error(
      `Anchor "${truncateForError(anchor)}" matches ${matches.length} lines in ${path}. ` +
        `Add 'occurrence' to edits[${editIndex}] to select which one:\n${previews}${extra}`
    );
  }

  return matches[0];
}

function truncateForError(text: string, maxLen = 60): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

// ─── Core Edit Logic ───────────────────────────────────────────────────────

interface EditPlan {
  /** The resolved anchored edits, sorted by start position */
  edits: AnchoredEdit[];
  /** The original content (LF-normalized, BOM stripped) */
  content: string;
  /** Original line ending */
  lineEnding: "\r\n" | "\n";
  /** BOM if present */
  bom: string;
}

function resolveEdits(
  lines: string[],
  rawEdits: Array<{
    start: string;
    end?: string;
    newText: string;
    inclusiveStart?: boolean;
    inclusiveEnd?: boolean;
    occurrence?: number;
    startOccurrence?: number;
    endOccurrence?: number;
  }>,
  path: string
): EditPlan {
  const anchored: AnchoredEdit[] = [];

  for (let i = 0; i < rawEdits.length; i++) {
    const edit = rawEdits[i];

    // Resolve occurrences: specific overrides general
    const startOcc = edit.startOccurrence ?? edit.occurrence;
    const endOcc = edit.endOccurrence ?? edit.occurrence;

    // Find start anchor
    const startMatches = findAnchorLines(lines, edit.start, startOcc);
    const startMatch = checkAnchorUnique(startMatches, edit.start, startOcc, i, path);

    let startLine: number;
    let endLine: number;

    if (edit.end !== undefined) {
      // Range mode: start + end anchors
      const endMatches = findAnchorLines(lines, edit.end, endOcc);
      const endMatch = checkAnchorUnique(endMatches, edit.end, endOcc, i, path);

      // inclusiveStart / inclusiveEnd default: false for range mode
      // (__FILE_BEGIN__ / __FILE_END__ override these below since they are
      // virtual markers, not real lines.)
      const isFileBegin = edit.start === "__FILE_BEGIN__";
      const isFileEnd = edit.end === "__FILE_END__";
      const incStart = edit.inclusiveStart !== undefined
        ? edit.inclusiveStart
        : false;
      const incEnd = edit.inclusiveEnd !== undefined
        ? edit.inclusiveEnd
        : false;

      startLine = incStart ? startMatch.lineIndex : startMatch.lineIndex + 1;
      endLine = incEnd ? endMatch.lineIndex : endMatch.lineIndex - 1;

      // __FILE_BEGIN__ / __FILE_END__ override inclusive settings since
      // they are virtual markers, not real lines.
      if (isFileBegin) startLine = 0;
      if (isFileEnd) endLine = lines.length - 1;

      // Validate range
      if (startLine > endLine) {
        throw new Error(
          `edits[${i}]: the region between anchors is empty or inverted. ` +
            `Start anchor at line ${startMatch.lineIndex + 1}, end anchor at line ${endMatch.lineIndex + 1}. ` +
            `Check inclusiveStart/inclusiveEnd settings.`
        );
      }
    } else {
      // Single-anchor mode
      const isFileBegin = edit.start === "__FILE_BEGIN__";
      const isFileEnd = edit.start === "__FILE_END__";

      const incStart =
        edit.inclusiveStart !== undefined ? edit.inclusiveStart : true;

      if (isFileBegin) {
        // Insert at beginning: prepend to file
        startLine = 0;
        endLine = -1; // empty range: start > end means insert before line 0
      } else if (isFileEnd) {
        // Append to file.
        // If the file has a trailing newline (last element is ""), insert before
        // the empty-string marker to avoid an extra blank line in the output.
        const lastLine = lines.length > 0 ? lines[lines.length - 1] : undefined;
        const hasTrailingNewline = lastLine === "";
        startLine = hasTrailingNewline ? lines.length - 1 : lines.length;
        endLine = startLine - 1; // empty range: start > end means insert
      } else if (incStart) {
        // Replace the anchor line
        startLine = startMatch.lineIndex;
        endLine = startMatch.lineIndex;
      } else {
        // Insert after the anchor line
        startLine = startMatch.lineIndex + 1;
        endLine = startMatch.lineIndex; // empty range: start > end means insert
      }
    }

    anchored.push({
      editIndex: i,
      startLine,
      endLine,
      // Strip a single trailing newline so that split-join round-trip doesn't
      // produce an unintended blank line. Users who need a trailing blank line
      // should end newText with "\n\n" (one will be stripped, one remains).
      newText: normalizeToLF(edit.newText).replace(/\n$/, ""),
    });
  }

  // Sort by start position, then by end position (longer first) for stable application
  anchored.sort((a, b) => {
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    return b.endLine - a.endLine; // longer first
  });

  // Check for overlapping edits
  for (let i = 1; i < anchored.length; i++) {
    const prev = anchored[i - 1];
    const curr = anchored[i];
    // Detect actual range overlaps
    if (curr.startLine <= prev.endLine) {
      throw new Error(
        `edits[${prev.editIndex}] and edits[${curr.editIndex}] overlap in ${path}. ` +
          `Merge them into one edit or target disjoint regions.`
      );
    }
    // Detect duplicate insert positions (both are insert-only: startLine > endLine)
    if (
      prev.startLine > prev.endLine &&
      curr.startLine > curr.endLine &&
      curr.startLine === prev.startLine
    ) {
      throw new Error(
        `edits[${prev.editIndex}] and edits[${curr.editIndex}] both insert at the same ` +
          `position (line ${curr.startLine}) in ${path}. Merge them into one edit.`
      );
    }
  }

  return { edits: anchored, content: "", lineEnding: "\n", bom: "" };
}

function applyAnchoredEdits(
  lines: string[],
  plan: EditPlan
): string[] {
  const result = [...lines];

  // Apply edits in reverse order so line indices stay stable
  for (let i = plan.edits.length - 1; i >= 0; i--) {
    const edit = plan.edits[i];
    const { startLine, endLine, newText } = edit;

    if (startLine > endLine) {
      // Insert mode: insert at startLine position (after the anchor line)
      if (newText === "") {
        // Nothing to insert
        continue;
      }
      const newLines = newText.split("\n");
      result.splice(startLine, 0, ...newLines);
    } else {
      // Replace mode: replace lines[startLine..endLine] with newText
      const newLines = newText === "" ? [] : newText.split("\n");
      result.splice(startLine, endLine - startLine + 1, ...newLines);
    }
  }

  return result;
}

// ─── Diff Generation ───────────────────────────────────────────────────────

/**
 * Generate a standard unified patch using the diff library.
 */
function generateUnifiedPatch(
  path: string,
  oldContent: string,
  newContent: string
): string {
  return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
    context: 4,
  });
}

/**
 * Generate a display-oriented diff with line numbers, using the diff library.
 * Mirrors the built-in edit tool's diff display format.
 */
function generateDiffDisplay(
  oldContent: string,
  newContent: string
): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const contextLines = 4;

  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    // Remove trailing empty string from split
    if (raw[raw.length - 1] === "") {
      raw.pop();
    }

    if (part.added || part.removed) {
      // Capture first changed line
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum;
      }

      // Show the change
      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(`+${lineNum} ${line}`);
          newLineNum++;
        } else {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(`-${lineNum} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      // Context lines
      const nextPartIsChange =
        i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
      const hasLeadingChange = lastWasChange;
      const hasTrailingChange = nextPartIsChange;

      if (hasLeadingChange && hasTrailingChange) {
        if (raw.length <= contextLines * 2) {
          for (const line of raw) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        } else {
          const leadingLines = raw.slice(0, contextLines);
          const trailingLines = raw.slice(raw.length - contextLines);
          const skippedLines =
            raw.length - leadingLines.length - trailingLines.length;
          for (const line of leadingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
          for (const line of trailingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        }
      } else if (hasLeadingChange) {
        const shownLines = raw.slice(0, contextLines);
        const skippedLines = raw.length - shownLines.length;
        for (const line of shownLines) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
        if (skippedLines > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }
      } else if (hasTrailingChange) {
        const skippedLines = Math.max(0, raw.length - contextLines);
        if (skippedLines > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }
        for (const line of raw.slice(skippedLines)) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      } else {
        // Skip these context lines entirely
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }
      lastWasChange = false;
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}

// ─── Tool Implementation ───────────────────────────────────────────────────

function resolvePath(rawPath: string, cwd: string): string {
  if (isAbsolute(rawPath)) return rawPath;
  // If it starts with ~, expand it
  if (rawPath.startsWith("~")) {
    return resolve(homedir(), rawPath.slice(1));
  }
  return resolve(cwd, rawPath);
}

async function executeAnchorEdit(
  cwd: string,
  params: {
    path: string;
    edits: Array<{
      start: string;
      end?: string;
      newText: string;
      inclusiveStart?: boolean;
      inclusiveEnd?: boolean;
      occurrence?: number;
      startOccurrence?: number;
      endOccurrence?: number;
    }>;
  },
  signal?: AbortSignal
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: { diff: string; patch: string; firstChangedLine?: number };
}> {
  const absolutePath = resolvePath(params.path, cwd);

  // Check for abort
  if (signal?.aborted) throw new Error("Operation aborted");

  // Check file accessibility
  try {
    await access(absolutePath, constants.R_OK | constants.W_OK);
  } catch (error: any) {
    const code = error?.code ? `Error code: ${error.code}` : String(error);
    throw new Error(`Could not edit file: ${params.path}. ${code}.`);
  }

  if (signal?.aborted) throw new Error("Operation aborted");

  // Read the file
  const buffer = await readFile(absolutePath);
  const rawContent = buffer.toString("utf-8");

  if (signal?.aborted) throw new Error("Operation aborted");

  // Handle BOM
  const { bom, text } = stripBom(rawContent);
  const originalEnding = detectLineEnding(text);
  const normalizedContent = normalizeToLF(text);
  const lines = normalizedContent.split("\n");

  // Resolve anchors and compute edit plan
  const plan = resolveEdits(lines, params.edits, params.path);
  plan.content = normalizedContent;
  plan.lineEnding = originalEnding;
  plan.bom = bom;

  if (signal?.aborted) throw new Error("Operation aborted");

  // Apply edits
  const oldLines = [...lines];
  const newLines = applyAnchoredEdits(lines, plan);

  // Check if anything changed
  if (
    oldLines.length === newLines.length &&
    oldLines.every((line, i) => line === newLines[i])
  ) {
    throw new Error(
      `No changes made to ${params.path}. The edits produced identical content. ` +
        `This might indicate anchors matched the wrong region or newText is the same as old text.`
    );
  }

  if (signal?.aborted) throw new Error("Operation aborted");

  // Restore line endings and BOM
  const newContent = newLines.join("\n");
  const finalContent = bom + restoreLineEndings(newContent, originalEnding);

  // Write the file
  await writeFile(absolutePath, finalContent, "utf-8");

  if (signal?.aborted) throw new Error("Operation aborted");

  // Generate diff for display (reuse newContent from above)
  const oldContent = oldLines.join("\n");
  const diffResult = generateDiffDisplay(oldContent, newContent);
  const patch = generateUnifiedPatch(params.path, oldContent, newContent);

  return {
    content: [
      {
        type: "text",
        text: `Successfully applied ${params.edits.length} anchor-based edit(s) in ${params.path}.`,
      },
    ],
    details: {
      diff: diffResult.diff,
      patch,
      firstChangedLine: diffResult.firstChangedLine,
    },
  };
}

// ─── Extension Entry Point ─────────────────────────────────────────────────

export default function anchorEditExtension(pi: ExtensionAPI) {
  // Disable the built-in edit tool on session start
  pi.on("session_start", () => {
    const activeTools = pi.getActiveTools();
    if (activeTools.includes("edit")) {
      pi.setActiveTools(activeTools.filter((t) => t !== "edit"));
    }
  });

  // Register the anchor_edit tool as a replacement for the built-in edit
  pi.registerTool({
    name: "anchor_edit",
    label: "edit (anchor)",
    description:
      "Edit a file using anchor-based text replacement. " +
      "Instead of requiring exact text matching, use distinctive anchor lines to identify the edit location. " +
      "Each edits[].start (and optional edits[].end) identifies a region by finding a line containing the anchor text. " +
      "All edits are matched against the original file, not after earlier edits are applied. " +
      "When multiple edits affect overlapping regions, merge them into one edit.",
    promptSnippet:
      "Edit files using anchor lines instead of exact text matching — more reliable than edit",
    promptGuidelines: [
      "Prefer anchor_edit over edit for all file editing — it uses anchor-based location instead of exact text matching",
      "Set edits[].start to a distinctive line (or part of a line) that uniquely identifies the edit location",
      "For range edits, set edits[].end to mark the end of the region; content between anchors is replaced with newText",
      "When changing multiple separate locations in one file, use one anchor_edit call with multiple edits[]",
      "Each edits[] is matched against the original file, not after earlier edits are applied",
      "Keep anchor text as short as possible while still being unique in the file",
      'Use "__FILE_BEGIN__" as start to insert at the beginning, "__FILE_END__" as end to reference end of file',
      "Set inclusiveStart/inclusiveEnd to control whether anchor lines themselves are replaced (default: inclusive if single anchor, exclusive if range)",
      "If an anchor matches multiple lines, add occurrence to disambiguate (1-indexed); use startOccurrence/endOccurrence for separate control",
    ],
    parameters: anchorEditSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeAnchorEdit(ctx.cwd, params as any, signal);
    },
  });
}
