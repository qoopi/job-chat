"use client";

import { Fragment, useState, type ReactNode } from "react";

// The Show-query reveal: the exact executed ClickHouse SQL, syntax-tinted via a small tokenizer (React nodes,
// no dangerouslySetInnerHTML). Keywords only - function names are classified by the `.fn` paren-check below.
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
    // A function name = an identifier followed by "(". Checked before the keyword test so a called `count` tints as fn, a bare column stays plain.
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
