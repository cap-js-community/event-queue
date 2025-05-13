using sap.eventqueue as db from '../../db/Event';
using { sap.common.CodeList } from '@sap/cds/common';

@path: 'event-queue/monitoring'
@impl: './event-queue-monitoring-service.js'
service EventQueueMonitoringService {

  @readonly
  entity Event as projection on db.Event {
    @title: '{i18n>ID}'
    ID,

    @title: '{i18n>Type}'
    type,

    @title: '{i18n>SubType}'
    subType,

    @title: '{i18n>Status}'
    status,

    @title: '{i18n>ReferenceEntity}'
    referenceEntity,

    @title: '{i18n>ReferenceEntityKey}'
    referenceEntityKey,

    @title: '{i18n>Context}'
    context,

    @title: '{i18n>StartAfter}'
    startAfter,

    @title: '{i18n>Status}'
    statusUi: Association to EventStatus on statusUi.code = status,

    @title: '{i18n>Payload}'
    payload,

    @title: '{i18n>Attempts}'
    attempts,

    @title: '{i18n>CreatedAt}'
    createdAt,
  } actions {
    action restartProcessing();
  }

  @title: '{i18n>Status}'
  entity EventStatus : CodeList {
    @title: '{i18n>StatusCode}'
    key code : db.Status;
  };
}
