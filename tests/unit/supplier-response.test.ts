/**
 * Believing a supplier, or not.
 *
 * These are the checks that can be made about a RESPONSE on its own, so they are
 * tested on their own. The other half of the defence — whether the code is
 * already spoken for — is deliberately not here: it is a fact about the world
 * that only the database can settle, and asserting it in a pure test would be
 * asserting the wrong thing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rejectSupplierResponse } from '../../src/domain/order/supplier-response.js';

const EXPECTED = { requestId: 'req_ABC-supplier_a-1', sku: 'KEY-CS2-PRIME' };

describe('supplier response validation', () => {
  it('accepts an answer about the right request for the right product', () => {
    assert.equal(
      rejectSupplierResponse({ requestId: EXPECTED.requestId, sku: EXPECTED.sku, code: 'AAAA-BBBB' }, EXPECTED),
      null,
    );
  });

  it('refuses an answer about a different request', () => {
    // Including one about an earlier epoch of the same line: that request was
    // closed as unusable, and its answer must not be resurrected.
    assert.equal(
      rejectSupplierResponse({ requestId: 'req_ABC-supplier_a-2', sku: EXPECTED.sku, code: 'AAAA' }, EXPECTED),
      'request_id_mismatch',
    );
  });

  it('refuses a code the supplier itself says is for another product', () => {
    assert.equal(
      rejectSupplierResponse({ requestId: EXPECTED.requestId, sku: 'KEY-GTA5', code: 'AAAA' }, EXPECTED),
      'sku_mismatch',
    );
  });

  it('accepts an answer that simply does not mention the product', () => {
    // Silence is not a contradiction. A supplier is not obliged to echo the sku,
    // and refusing every answer that omits it would break a contract we do not
    // control — while catching nothing, since a supplier that lies about the sku
    // is caught by the code registry anyway.
    assert.equal(
      rejectSupplierResponse({ requestId: EXPECTED.requestId, sku: null, code: 'AAAA' }, EXPECTED),
      null,
    );
  });

  it('refuses an empty code', () => {
    for (const code of ['', '   ']) {
      assert.equal(
        rejectSupplierResponse({ requestId: EXPECTED.requestId, sku: EXPECTED.sku, code }, EXPECTED),
        'malformed_code',
      );
    }
  });

  it('reports the request mismatch first when an answer is wrong in several ways', () => {
    // The most fundamental defect wins: if the answer is not even about our
    // request, nothing else it says is worth interpreting.
    assert.equal(
      rejectSupplierResponse({ requestId: 'req_OTHER-supplier_a-1', sku: 'KEY-GTA5', code: '' }, EXPECTED),
      'request_id_mismatch',
    );
  });
});
