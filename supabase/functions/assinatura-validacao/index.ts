import { createVerificationHandler } from './handler.mjs';

// This endpoint is public only for possession of a document's random code or
// full SHA-256 digest. It has no clinical, account, signing or write routes.
Deno.serve(createVerificationHandler({ env: (name: string) => Deno.env.get(name) }));
