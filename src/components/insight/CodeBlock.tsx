"use client";

import { Fragment, useState, type ReactNode } from "react";

// The Show-query reveal (AC-6): the exact executed ClickHouse SQL in a theme-native code block (refresh
// #2 s1 - light grey + dark tokens on light, dark grey + light tokens on dark) with a Copy action
// ("Copied" for 1.5s). Read-only. Syntax tint (kw/fn/str/num) via a small tokenizer - React nodes only,
// no dangerouslySetInnerHTML.
// Pure keywords only: function names (count, round, max, now, toString, ...) are classified by the
// `.fn` paren-check below (which runs first), so a bare identifier like a `count` column reads as an
// identifier, not a keyword (the refresh #2 s1 fix). Keeping those function-words here would be dead.
const KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "AS",
  "GROUP",
  "BY",
  "ORDER",
  "LIMIT",
  "WITH",
  "INTERVAL",
  "DAY",
  "ILIKE",
  "LIKE",
  "IN",
  "NOT",
  "NULL",
  "IS",
  "ON",
  "JOIN",
  "DESC",
  "ASC",
  "FINAL",
]);

function highlight(sql: string): ReactNode[] {
  // Split into strings, numbers, words, and everything else, keeping the delimiters.
  const tokens = sql.split(/('(?:[^'\\]|\\.)*'|\b\d+(?:\.\d+)?\b|\w+)/g);
  return tokens.map((tok, i) => {
    if (tok === "") return null;
    if (/^'[\s\S]*'$/.test(tok))
      return (
        <span key={i} className="str">
          {tok}
        </span>
      );
    if (/^\d/.test(tok))
      return (
        <span key={i} className="num">
          {tok}
        </span>
      );
    // A function name is an identifier immediately followed by "(" (count, quantile, toString, ...).
    // Checked before the keyword test so aggregate calls tint as functions, and so a called name is
    // distinct from a bare column/table identifier (which stays plain -> --text, the refresh #2 fix).
    if (/^\w+$/.test(tok) && /^\s*\(/.test(tokens[i + 1] ?? ""))
      return (
        <span key={i} className="fn">
          {tok}
        </span>
      );
    if (KEYWORDS.has(tok.toUpperCase()))
      return (
        <span key={i} className="kw">
          {tok}
        </span>
      );
    return <Fragment key={i}>{tok}</Fragment>;
  });
}

export function CodeBlock({ sql }: { sql: string }) {
  const [copied, setCopied] = useState(false);

  function onCopy() {
    navigator.clipboard?.writeText(sql);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="codeblock">
      <button className="copy-btn" type="button" onClick={onCopy}>
        {copied ? "Copied" : "Copy"}
      </button>
      <pre style={{ paddingRight: 60 }}>{highlight(sql)}</pre>
    </div>
  );
}
