//  © 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
//  This AWS Content is provided subject to the terms of the AWS Customer Agreement available at
//  http: // aws.amazon.com/agreement or other written agreement between Customer and either
//  Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
import crypto from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { HttpRequest } from '@aws-sdk/protocol-http';
import { default as fetch, Request } from 'node-fetch';

const { Sha256 } = crypto;

const UPDATE_SESSIONS = /* GraphQL */ `
  mutation UpdateSessions(
    $input: UpdateSessionsInput!
    $condition: ModelSessionsConditionInput
  ) {
    updateSessions(input: $input, condition: $condition) {
      id
      startTime
      endTime
      username
      accountId
      role
      approver_ids
      queryId
      createdAt
      updatedAt
      owner
    }
  }
`;

export async function updateSessionQueryId({ endpoint, region, id, queryId }) {
  const url = new URL(endpoint);
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region,
    service: 'appsync',
    sha256: Sha256
  });

  const signed = await signer.sign(new HttpRequest({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      host: url.host
    },
    hostname: url.host,
    body: JSON.stringify({ query: UPDATE_SESSIONS, variables: { input: { id, queryId } } }),
    path: url.pathname
  }));

  const response = await fetch(new Request(url, signed));
  const body = await response.json();
  if (!response.ok || body.errors) {
    throw new Error(`updateSessions failed for session ${id}: ${JSON.stringify(body.errors ?? response.status)}`);
  }
  return body.data.updateSessions;
}
