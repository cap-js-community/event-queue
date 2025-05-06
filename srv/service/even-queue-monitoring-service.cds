using sap.eventqueue as db from '../../db/Event';

@path: 'event-queue/monitoring'
service EventQueueMonitoringService {

  entity Event as projection on db.Event;

}