#!/usr/bin/env node
// Maakt de sleutel van LEAP voor de Canvas-koppeling (server/lti/lti.js).
// De UITVOER is geheim: zet hem in Key Vault als LTI_TOOL_PRIVATE_JWK, nooit in de repo.
// De bijbehorende publieke sleutel staat daarna vanzelf op <app>/lti/jwks en in
// <app>/lti/config.json (voor de Canvas-beheerders).
//
//   node scripts/lti-keygen.mjs
import { generateKeyPair, exportJWK } from 'jose';
import { randomUUID } from 'node:crypto';

const { privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
const jwk = { ...(await exportJWK(privateKey)), kid: `leap-${randomUUID().slice(0, 8)}`, alg: 'RS256', use: 'sig' };
console.log(JSON.stringify(jwk));
console.error('\nZet de regel hierboven in Key Vault als LTI_TOOL_PRIVATE_JWK (geheim!).');
