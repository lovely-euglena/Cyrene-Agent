export function buildLearnExamCsp(isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self'${isDev ? " 'unsafe-eval' 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${isDev ? " http://localhost:5173 ws://localhost:5173" : ""}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
