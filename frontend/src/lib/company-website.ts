/** Convenience validation only; the backend still validates public HTTPS and DNS. */
export function companyWebsite(value: string): string {
  const input = value.trim();
  if (!input) throw new Error('Enter your company website to get started.');
  if (input.length > 2048) throw new Error('This website address is too long. Enter the company homepage instead.');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error('Enter a website such as hivesales.io or https://hivesales.io.');
  }
  if (url.protocol !== 'https:') throw new Error('Use the secure HTTPS address for your company website.');
  if (url.username || url.password) throw new Error('Enter a public company website without sign-in details.');
  if (!url.hostname.includes('.') || url.hostname.endsWith('.') || /^(?:\d+\.){3}\d+$/.test(url.hostname)) {
    throw new Error('Enter a public company domain, such as hivesales.io.');
  }
  return url.toString();
}
