using EventQueueMonitoringService from '../../srv/service';

annotate EventQueueMonitoringService.Event with @(
  UI.FieldGroup #General       : {
    $Type: 'UI.FieldGroupType',
    Data : [
      {
        $Type: 'UI.DataField',
        Value: ID,
      },
      {
        $Type: 'UI.DataField',
        Value: payload,
      },
      {
        $Type: 'UI.DataField',
        Value: referenceEntity,
      },
      {
        $Type: 'UI.DataField',
        Value: referenceEntityKey,
      },
      {
        $Type: 'UI.DataField',
        Value: status,
      },
    ],
  },
  UI.FieldGroup #Details       : {
    $Type: 'UI.FieldGroupType',
    Data : [
      {
        $Type: 'UI.DataField',
        Value: context,
      },
    ],
  },
  UI.FieldGroup #Administrative: {
    $Type: 'UI.FieldGroupType',
    Data : [
      {
        $Type: 'UI.DataField',
        Value: createdAt,
      },
      {
        $Type: 'UI.DataField',
        Value: startAfter,
      },
    ],
  },
  UI.HeaderFacets              : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : '{i18n>General}',
      Target: '@UI.FieldGroup#General',
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : '{i18n>Details}',
      Target: '@UI.FieldGroup#Details',
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : '{i18n>Administrative}',
      Target: '@UI.FieldGroup#Administrative',
    }
  ],
  UI.LineItem                  : [
    {
      $Type: 'UI.DataField',
      Value: ID,
    },
    {
      $Type: 'UI.DataField',
      Value: type,
    },
    {
      $Type: 'UI.DataField',
      Value: subType,
    },
    {
      $Type: 'UI.DataField',
      Value: status,
    },
    {
      $Type: 'UI.DataField',
      Value: attempts,
    },
    {
      $Type: 'UI.DataField',
      Value: payload,
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'EventQueueMonitoringService.restartProcessing',
      Label : '{i18n>RestartProcessing}'
    }
  ],
  UI.HeaderInfo                : {
    $Type         : 'UI.HeaderInfoType',
    TypeName      : '{i18n>Event}',
    TypeNamePlural: '{i18n>Events}',
    Title         : {
      Label: '{i18n>Event}',
      Value: ID
    },
    Description   : {Value: type}
  },
  UI.PresentationVariant       : {
    Visualizations: ['@UI.LineItem'],
    SortOrder     : [{
      $Type     : 'Common.SortOrderType',
      Property  : createdAt,
      Descending: true
    }]
  },
  UI.SelectionFields           : [
    type,
    subType,
    status,
  ],
);

annotate EventQueueMonitoringService.Event {
  status  @ValueList                      : {
    entity: 'EventStatus',
    type  : #Fixed
  }
  @Common.ValueListWithFixedValues
  @Common.Text: statusUi.descr  @Common.TextArrangement: #TextFirst;
  }
