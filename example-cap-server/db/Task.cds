namespace sap.eventqueue.sample;

using cuid from '@sap/cds/common';
using managed from '@sap/cds/common';

entity Task: cuid, managed {
    description: String;
    status: String default 'open';
}