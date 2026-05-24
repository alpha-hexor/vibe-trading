const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
};

function color(text, ...styles) {
  return `${styles.join("")}${text}${ANSI.reset}`;
}

let assistantStreamState = null;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(text) {
  return stripAnsi(text).length;
}

function padVisible(text, width) {
  return `${text}${" ".repeat(Math.max(0, width - visibleLength(text)))}`;
}

function renderInlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, (_, value) => color(value, ANSI.yellow))
    .replace(/\*\*([^*]+)\*\*/g, (_, value) => color(value, ANSI.bold, ANSI.white))
    .replace(/__([^_]+)__/g, (_, value) => color(value, ANSI.bold, ANSI.white))
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_, value) => color(value, ANSI.italic))
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, (_, value) => color(value, ANSI.italic));
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function parseTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function renderTable(lines, startIndex) {
  const rows = [];
  let index = startIndex;

  while (index < lines.length && lines[index].includes("|")) {
    if (!isTableSeparator(lines[index])) {
      rows.push(parseTableRow(lines[index]));
    }
    index += 1;
  }

  if (rows.length === 0) {
    return { lines: [renderInlineMarkdown(lines[startIndex])], nextIndex: startIndex + 1 };
  }

  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.max(
      ...rows.map((row) => visibleLength(renderInlineMarkdown(row[columnIndex] ?? ""))),
    ),
  );

  const rendered = rows.map((row, rowIndex) => {
    const cells = widths.map((width, columnIndex) =>
      padVisible(renderInlineMarkdown(row[columnIndex] ?? ""), width),
    );
    const line = `  ${cells.join(color(" │ ", ANSI.gray))}`;
    return rowIndex === 0 ? color(line, ANSI.bold, ANSI.white) : line;
  });

  return { lines: rendered, nextIndex: index };
}

function createMarkdownState() {
  return {
    inCodeBlock: false,
    pendingText: "",
    pendingLine: null,
    tableLines: null,
    lastPrintedBlank: true,
  };
}

function renderMarkdownLine(line, state) {
  const fence = line.match(/^\s*```([A-Za-z0-9_-]*)\s*$/);

  if (fence) {
    state.inCodeBlock = !state.inCodeBlock;
    if (state.inCodeBlock && fence[1]) {
      return color(`  ${fence[1]}`, ANSI.gray);
    }
    return null;
  }

  if (state.inCodeBlock) {
    return color(`  ${line}`, ANSI.gray);
  }

  if (line.trim() === "") {
    return "";
  }

  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    const prefix = heading[1].length === 1 ? "" : `${"  ".repeat(heading[1].length - 1)}`;
    return color(`${prefix}${renderInlineMarkdown(heading[2])}`, ANSI.bold, ANSI.cyan);
  }

  const quote = line.match(/^\s*>\s?(.*)$/);
  if (quote) {
    return color("│ ", ANSI.gray) + color(renderInlineMarkdown(quote[1]), ANSI.dim);
  }

  const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/);
  if (unordered) {
    const indent = " ".repeat(Math.floor(unordered[1].length / 2) * 2);
    return `${indent}${color("•", ANSI.cyan)} ${renderInlineMarkdown(unordered[2])}`;
  }

  const ordered = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
  if (ordered) {
    const indent = " ".repeat(Math.floor(ordered[1].length / 2) * 2);
    return `${indent}${color(`${ordered[2]}.`, ANSI.cyan)} ${renderInlineMarkdown(ordered[3])}`;
  }

  return renderInlineMarkdown(line);
}

function appendRenderedLine(output, line, state) {
  if (line === null) {
    return;
  }
  if (line === "") {
    if (!state.lastPrintedBlank) {
      output.push("");
      state.lastPrintedBlank = true;
    }
    return;
  }
  output.push(line);
  state.lastPrintedBlank = false;
}

function flushMarkdownLine(line, state) {
  const output = [];

  if (state.tableLines) {
    if (line.includes("|") || isTableSeparator(line)) {
      state.tableLines.push(line);
      return output;
    }

    appendRenderedTable(output, state);
  }

  if (state.pendingLine === null) {
    state.pendingLine = line;
    return output;
  }

  if (
    !state.inCodeBlock &&
    state.pendingLine.includes("|") &&
    isTableSeparator(line)
  ) {
    state.tableLines = [state.pendingLine, line];
    state.pendingLine = null;
    return output;
  }

  appendRenderedLine(output, renderMarkdownLine(state.pendingLine, state), state);
  state.pendingLine = line;
  return output;
}

function appendRenderedTable(output, state) {
  const table = renderTable(state.tableLines, 0);
  for (const line of table.lines) {
    appendRenderedLine(output, line, state);
  }
  state.tableLines = null;
}

function finishMarkdownStream(state) {
  const output = [];

  if (state.pendingText) {
    for (const line of state.pendingText.split(/\r?\n/)) {
      output.push(...flushMarkdownLine(line, state));
    }
    state.pendingText = "";
  }

  if (state.tableLines) {
    appendRenderedTable(output, state);
  }

  if (state.pendingLine !== null) {
    appendRenderedLine(output, renderMarkdownLine(state.pendingLine, state), state);
    state.pendingLine = null;
  }

  return output.join("\n");
}

function appendMarkdownStream(text, state) {
  state.pendingText += text;
  const lines = state.pendingText.split(/\r?\n/);
  state.pendingText = lines.pop() ?? "";

  const output = [];
  for (const line of lines) {
    output.push(...flushMarkdownLine(line, state));
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function renderMarkdown(text) {
  const state = createMarkdownState();
  state.pendingText = String(text ?? "").trim();
  return finishMarkdownStream(state).replace(/\n{3,}/g, "\n\n");
}

export function promptLabel() {
  return `${color("claude", ANSI.bold, ANSI.white)}${color("-", ANSI.gray)}${color(
    "future",
    ANSI.bold,
    ANSI.cyan,
  )}${color(" >", ANSI.gray)}`;
}

export function printBanner(config) {
  console.log("");
  console.log(color("  Claude Future", ANSI.bold, ANSI.white));
  console.log(color("  Futures trading terminal", ANSI.gray));
  console.log(color("  CoinSwitch market tools + OpenRouter analysis", ANSI.gray));
  console.log("");
  console.log(
    `${color("  model", ANSI.gray)} ${color(config.openRouterModel, ANSI.cyan)}`
  );
  console.log(`${color("  commands", ANSI.gray)} /help`);
  console.log("");
}

export function printStatus(label, detail = "") {
  const suffix = detail ? ` ${color(detail, ANSI.gray)}` : "";
  console.log(`${color("●", ANSI.cyan)} ${color(label, ANSI.white)}${suffix}`);
}

export function startSpinner(label, { detail = "", phrases = [], intervalMs = 90 } = {}) {
  let frameIndex = 0;
  let phraseIndex = 0;
  let stopped = false;
  const startedAt = Date.now();

  function currentDetail() {
    if (phrases.length === 0) {
      return detail;
    }
    phraseIndex = Math.floor((Date.now() - startedAt) / 1600) % phrases.length;
    return phrases[phraseIndex];
  }

  function clearLine() {
    process.stdout.write("\r\x1b[2K");
  }

  function render() {
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    frameIndex += 1;
    const suffix = currentDetail();
    const text = suffix
      ? `${color(frame, ANSI.cyan)} ${color(label, ANSI.white)} ${color(suffix, ANSI.gray)}`
      : `${color(frame, ANSI.cyan)} ${color(label, ANSI.white)}`;
    clearLine();
    process.stdout.write(text);
  }

  render();
  const timer = setInterval(render, intervalMs);
  timer.unref?.();

  return {
    stop({ persist = false } = {}) {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      clearLine();
      if (persist) {
        const suffix = currentDetail();
        console.log(
          suffix
            ? `${color("●", ANSI.cyan)} ${color(label, ANSI.white)} ${color(suffix, ANSI.gray)}`
            : `${color("●", ANSI.cyan)} ${color(label, ANSI.white)}`,
        );
      }
    },
  };
}

export function printSuccess(label, detail = "") {
  const suffix = detail ? ` ${color(detail, ANSI.gray)}` : "";
  console.log(`${color("●", ANSI.green)} ${color(label, ANSI.white)}${suffix}`);
}

export function printError(message) {
  console.error(`${color("●", ANSI.red)} ${color(message, ANSI.white)}`);
}

export function printPanel(title, lines) {
  console.log(color(`┌─ ${title}`, ANSI.gray));
  for (const line of lines) {
    console.log(color("│ ", ANSI.gray) + line);
  }
  console.log(color("└", ANSI.gray));
}

export function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

export function formatPct(value, digits = 2) {
  return Number.isFinite(value) ? `${value.toFixed(digits)}%` : "n/a";
}

export function sectionBreak() {
  console.log(color("─".repeat(72), ANSI.gray));
}

export function renderAssistantText(text) {
  sectionBreak();
  console.log(color("assistant", ANSI.bold, ANSI.white));
  console.log(renderMarkdown(text));
  sectionBreak();
}

export function beginAssistantStream() {
  assistantStreamState = createMarkdownState();
  sectionBreak();
  process.stdout.write(`${color("assistant", ANSI.bold, ANSI.white)}\n`);
}

export function appendAssistantStream(text) {
  assistantStreamState ??= createMarkdownState();
  const rendered = appendMarkdownStream(text, assistantStreamState);
  if (rendered) {
    process.stdout.write(`${rendered}\n`);
  }
}

export function endAssistantStream() {
  const rendered = finishMarkdownStream(assistantStreamState ?? createMarkdownState());
  assistantStreamState = null;
  if (rendered) {
    process.stdout.write(`${rendered}\n`);
  }
  sectionBreak();
}
