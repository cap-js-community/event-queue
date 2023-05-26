namespace sap.eventqueue;

using cuid from '@sap/cds/common';
using managed from '@sap/cds/common';

@cds.persistence.journal
@assert.unique.semanticKey: [code]
entity Lock: managed {
    code: String not null;
    value: String;
}
