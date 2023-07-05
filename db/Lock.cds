namespace sap.eventqueue;

using cuid from '@sap/cds/common';
using managed from '@sap/cds/common';

@assert.unique.semanticKey: [code]
entity Lock: managed {
    code: String not null;
    value: String;
}
