using sap.eventqueue as db from '../../db';

@path: 'event-queue/admin'
@impl: './admin-service.js'
@requires: 'internal-user'
service EventQueueAdminService {

  @readonly
  @cds.persistence.skip
  entity Event as projection on db.Event {
        null as tenant: String,
        null as landscape: String,
        null as space: String,
        *
  } actions {
      action setStatusAndAttempts(
        // TODO: remove tenant as soon as CAP issue is fixed https://github.tools.sap/cap/issues/issues/18445
        @mandatory
        tenant: String,
        status: db.Status,
        @assert.range: [0,100]
        attempts: Integer) returns Event;
    }

  @cds.persistence.skip
  @readonly
  entity Lock {
    key tenant: String;
    key type: String;
    key subType: String;
    landscape: String;
    space: String;
    ttl: Integer;
    createdAt: Integer;
  } actions {
      action releaseLock(
        // TODO: remove tenant as soon as CAP issue is fixed https://github.tools.sap/cap/issues/issues/18445
        @mandatory
        tenant: String,
        @mandatory
        type: String,
        @mandatory
        subType: String) returns Boolean;
    }

   @readonly
   @cds.persistence.skip
   entity Tenant {
      Key ID: String;
      subdomain: String;
      metadata: String;
   }
}
