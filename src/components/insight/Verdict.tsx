import { splitFirstNumber } from "@/lib/insight-format";

/** The verdict line with its first number bolded (the number is the hero); shared by the insight + postings cards. */
export function Verdict({ text }: { text: string }) {
  const split = splitFirstNumber(text);
  if (!split) return <p className="verdict">{text}</p>;
  const [pre, num, post] = split;
  return (
    <p className="verdict">
      {pre}
      <b>{num}</b>
      {post}
    </p>
  );
}
