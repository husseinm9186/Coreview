/**
 * What an empty list says (LT-449): what was looked for, and why nothing
 * came back — the D-050 rule applied to the sentence. One component so
 * every panel says it the same way, and none says nothing.
 */
export function EmptyState({ what, why, children }: { what: string; why?: string; children?: React.ReactNode }) {
  return (
    <p className="cv-help cv-empty" role="status">
      <span className="cv-empty-what">{what}</span>
      {why && <> {why}</>}
      {children}
    </p>
  );
}
