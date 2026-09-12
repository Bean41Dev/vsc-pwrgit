/**
 * Normalize a user-entered branch name into a valid git ref fragment.
 * Trims ends and collapses each run of whitespace to a single "-", since git
 * refuses spaces in ref names. Returns "" when nothing usable remains.
 */
export function sanitizeBranchName(name: string): string {
  return name.trim().replace(/\s+/g, "-");
}
