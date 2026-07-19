"use client";

import { Fragment, useState, type ReactNode } from "react";

// The Show-query reveal (AC-6): the exact executed ClickHouse SQL in an always-dark code block with a
// Copy action ("Copied" for 1.5s). Read-only. Light syntax tint (kw/str/num) via a small tokenizer -
// React nodes only, no dangerouslySetInnerHTML.
const KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "AND", "OR", "AS", "GROUP", "BY", "ORDER", "LIMIT", "WITH",
  "INTERVAL", "DAY", "ILIKE", "LIKE", "IN", "NOT", "NULL", "IS", "ON", "JOIN", "DESC", "ASC",
  "COUNT", "FINAL", "NOW", "TOSTRING", "TODATE", "ROUND", "FLOOR", "MAX", "MIN", "SELECT",
]);

function highlight(sql: string): ReactNode[] {
  // Split into strings, numbers, words, and everything else, keeping the delimiters.
  const tokens = sql.split(/('(?:[^'\\]|\\.)*'|\b\d+(?:\.\d+)?\b|\w+)/g);
  return tokens.map((tok, i) => {
    if (tok === "") return null;
    if (/^'[\s\S]*'$/.test(tok)) return <span key={i} className="str">{tok}</span>;
    if (/^\d/.test(tok)) return <span key={i} className="num">{tok}</span>;
    if (KEYWORDS.has(tok.toUpperCase())) return <span key={i} className="kw">{tok}</span>;
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
