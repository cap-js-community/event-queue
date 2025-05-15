using sap.eventqueue as db from '../../db';

@path: 'event-queue/admin'
@impl: './admin-service.js'
@requires: 'internal-user'
service EventQueueAdminService {

  @readonly
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

   @readonly
   entity Tenant {
      Key ID: String;
      subdomain: String;
   }
}
