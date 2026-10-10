/** Where players report problems. The repo is public; the template asks for what triage needs. */
export const ISSUES_URL = 'https://github.com/Zaphiruz/daemonet/issues/new?template=bug_report.yml';

export function ReportBug({ className = '' }: { className?: string }) {
  return (
    <a className={`text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline ${className}`} href={ISSUES_URL} target="_blank" rel="noopener noreferrer" data-testid="report-bug">
      report a bug
    </a>
  );
}
