/////////////////////////////////////////////////////////////
//
// pgAdmin 4 - PostgreSQL Tools
//
// Copyright (C) 2013 - 2021, The pgAdmin Development Team
// This software is released under the PostgreSQL Licence
//
//////////////////////////////////////////////////////////////

define('misc.statistics', [
  'sources/gettext', 'underscore', 'jquery', 'backbone',
  'sources/pgadmin', 'pgadmin.browser', 'pgadmin.backgrid', 'alertify', 'sources/size_prettify',
  'sources/misc/statistics/statistics',
], function(
  gettext, _, $, Backbone, pgAdmin, pgBrowser, Backgrid, Alertify, sizePrettify,
  statisticsHelper
) {

  if (pgBrowser.NodeStatistics)
    return pgBrowser.NodeStatistics;

  pgBrowser.NodeStatistics = pgBrowser.NodeStatistics || {};

  if (pgBrowser.NodeStatistics.initialized) {
    return pgBrowser.NodeStatistics;
  }

  var SizeFormatter = Backgrid.SizeFormatter = function() {};
  _.extend(SizeFormatter.prototype, {
    /**
       Takes a raw value from a model and returns the human readable formatted
       string for display.

       @member Backgrid.SizeFormatter
       @param {*} rawData
       @param {Backbone.Model} model Used for more complicated formatting
       @return {*}
    */
    fromRaw: function(rawData) {
      return sizePrettify(rawData);
    },
    toRaw: function(formattedData) {
      return formattedData;
    },
  });

  var PGBooleanCell = Backgrid.Extension.SwitchCell.extend({
      defaults: _.extend({}, Backgrid.Extension.SwitchCell.prototype.defaults),
    }),
    typeCellMapper = {
      // boolean
      16: PGBooleanCell,
      // int8
      20: Backgrid.IntegerCell,
      // int2
      21: Backgrid.IntegerCell,
      // int4
      23: Backgrid.IntegerCell,
      // float4
      700: Backgrid.NumberCell,
      // float8
      701: Backgrid.NumberCell,
      // numeric
      1700: Backgrid.NumberCell,
      // abstime
      702: Backgrid.DatetimeCell,
      // reltime
      703: Backgrid.DatetimeCell,
      // date
      1082: Backgrid.DatetimeCell.extend({
        includeDate: true,
        includeTime: false,
        includeMilli: false,
      }),
      // time
      1083: Backgrid.DatetimeCell.extend({
        includeDate: false,
        includeTime: true,
        includeMilli: true,
      }),
      // timestamp
      1114: Backgrid.DatetimeCell.extend({
        includeDate: true,
        includeTime: true,
        includeMilli: true,
      }),
      // timestamptz
      1184: 'string'
      /* Backgrid.DatetimeCell.extend({
              includeDate: true, includeTime: true, includeMilli: true
            }) */
      ,
      1266: 'string',
      /* Backgrid.DatetimeCell.extend({
            includeDate: false, includeTime: true, includeMilli: true
          }) */
    },
    GRID_CLASSES = 'backgrid presentation table table-bordered table-noouter-border table-hover',
    wcDocker = window.wcDocker;

  _.extend(
    PGBooleanCell.prototype.defaults.options, {
      onText: gettext('True'),
      offText: gettext('False'),
      onColor: 'success',
      offColor: 'ternary',
      size: 'mini',
    }
  );

  _.extend(pgBrowser.NodeStatistics, {
    init: function() {
      if (this.initialized) {
        return;
      }
      this.initialized = true;
      _.bindAll(
        this,
        'showStatistics', 'toggleVisibility',
        '__createMultiLineStatistics', '__createSingleLineStatistics', '__loadMoreRows');

      _.extend(
        this, {
          collection: new(Backbone.Collection)(null),
          statistic_columns: [{
            editable: false,
            name: 'statistics',
            label: gettext('Statistics'),
            cell: 'string',
            headerCell: Backgrid.Extension.CustomHeaderCell,
            cellHeaderClasses: 'width_percent_25',
          }, {
            editable: false,
            name: 'value',
            label: gettext('Value'),
            cell: 'string',
          }],
          columns: null,
          grid: null,
        });

      this.panel = pgBrowser.docker.findPanels('statistics');
      if(this.panel.length > 0) this.toggleVisibility(this.panel[0].isVisible());
    },

    toggleVisibility: function(visible, closed=false) {
      if (visible) {
        this.panel = pgBrowser.docker.findPanels('statistics');
        var t = pgBrowser.tree,
          i = t.selected(),
          d = i && t.itemData(i),
          n = i && d && pgBrowser.Nodes[d._type];

        pgBrowser.NodeStatistics.showStatistics.apply(
          pgBrowser.NodeStatistics, [i, d, n]
        );

        // We will start listening the tree selection event.
        pgBrowser.Events.on(
          'pgadmin-browser:tree:selected',
          pgBrowser.NodeStatistics.showStatistics
        );
        pgBrowser.Events.on(
          'pgadmin-browser:tree:refreshing',
          pgBrowser.NodeStatistics.refreshStatistics,
          this
        );
      } else {
        if(closed) {
          $(this.panel[0]).data('node-prop', '');
        }
        // We don't need to listen the tree item selection event.
        pgBrowser.Events.off(
          'pgadmin-browser:tree:selected',
          pgBrowser.NodeStatistics.showStatistics
        );
        pgBrowser.Events.off(
          'pgadmin-browser:tree:refreshing',
          pgBrowser.NodeStatistics.refreshStatistics,
          this
        );
      }
    },

    // Fetch the actual data and update the collection
    __updateCollection: function(url, node, item, node_type) {
      var $container = this.panel[0].layout().scene().find('.pg-panel-content'),
        $msgContainer = $container.find('.pg-panel-statistics-message'),
        $gridContainer = $container.find('.pg-panel-statistics-container'),
        panel = this.panel,
        self = this,
        msg = '',
        n_type = node_type;

      if (node) {
        msg = gettext('No statistics are available for the selected object.');
        /* We fetch the statistics only for those node who set the parameter
         * showStatistics function.
         */

        // Avoid unnecessary reloads
        var treeHierarchy = pgBrowser.tree.getTreeNodeHierarchy(item);
        var cache_flag = {
          node_type: node_type,
          url: url,
        };
        if (_.isEqual($(panel[0]).data('node-prop'), cache_flag)) {
          return;
        }
        // Cache the current IDs for next time
        $(panel[0]).data('node-prop', cache_flag);

        if (statisticsHelper.nodeHasStatistics(pgBrowser, node, item)) {
          msg = '';
          var timer;
          // Set the url, fetch the data and update the collection
          var ajaxHook = function() {
            $.ajax({
              url: url,
              type: 'GET',
              beforeSend: function(xhr) {
                xhr.setRequestHeader(
                  pgAdmin.csrf_token_header, pgAdmin.csrf_token
                );
                // Generate a timer for the request
                timer = setTimeout(function() {
                  // notify user if request is taking longer than 1 second

                  $msgContainer.text(gettext('Retrieving data from the server...'));
                  $msgContainer.removeClass('d-none');
                  if (self.grid) {
                    self.grid.remove();
                  }
                }, 1000);
              },
            })
              .done(function(res) {
              // clear timer and reset message.
                clearTimeout(timer);
                $msgContainer.text('');
                if (res.data) {
                  var data = self.data = res.data;
                  if (node.hasCollectiveStatistics || data['rows'].length > 1) {
                  // Listen scroll event to load more rows
                    pgBrowser.Events.on(
                      'pgadmin-browser:panel-statistics:' +
                    wcDocker.EVENT.SCROLLED,
                      self.__loadMoreRows
                    );
                    self.__createMultiLineStatistics.call(self, data, node.statsPrettifyFields);
                  } else {
                  // Do not listen the scroll event
                    pgBrowser.Events.off(
                      'pgadmin-browser:panel-statistics:' +
                    wcDocker.EVENT.SCROLLED,
                      self.__loadMoreRows
                    );
                    self.__createSingleLineStatistics.call(self, data, node.statsPrettifyFields);
                  }

                  if (self.grid) {
                    delete self.grid;
                    self.grid = null;
                  }

                  self.grid = new Backgrid.Grid({
                    emptyText: gettext('No data found'),
                    columns: self.columns,
                    collection: self.collection,
                    className: GRID_CLASSES,
                  });
                  self.grid.render();
                  $gridContainer.empty();
                  $gridContainer.append(self.grid.$el);

                  if (!$msgContainer.hasClass('d-none')) {
                    $msgContainer.addClass('d-none');
                  }
                  $gridContainer.removeClass('d-none');

                } else if (res.info) {
                  if (!$gridContainer.hasClass('d-none')) {
                    $gridContainer.addClass('d-none');
                  }
                  $msgContainer.text(res.info);
                  $msgContainer.removeClass('d-none');
                }
              })
              .fail(function(xhr, error, message) {
                var _label = treeHierarchy[n_type].label;
                pgBrowser.Events.trigger(
                  'pgadmin:node:retrieval:error', 'statistics', xhr, error, message, item
                );
                if (!Alertify.pgHandleItemError(xhr, error, message, {
                  item: item,
                  info: treeHierarchy,
                })) {
                  Alertify.pgNotifier(
                    error, xhr,
                    gettext('Error retrieving the information - %s', message || _label),
                    function(alertMsg) {
                      if(alertMsg === 'CRYPTKEY_SET') {
                        ajaxHook();
                      } else {
                        console.warn(arguments);
                      }
                    }
                  );
                }
                // show failed message.
                $msgContainer.text(gettext('Failed to retrieve data from the server.'));
              });
          };

          ajaxHook();
        }
      }
      if (msg != '') {
        // Hide the grid container and show the default message container
        if (!$gridContainer.hasClass('d-none'))
          $gridContainer.addClass('d-none');
        $msgContainer.removeClass('d-none');

        $msgContainer.text(msg);
      }
    },
    refreshStatistics: function(item, data, node) {
      var that = this,
        cache_flag = {
          node_type: data._type,
          url: node.generate_url(item, 'stats', data, true),
        };

      if (_.isEqual($(that.panel[0]).data('node-prop'), cache_flag)) {
        // Reset the current item selection
        $(that.panel[0]).data('node-prop', '');
        that.showStatistics(item, data, node);
      }
    },
    showStatistics: function(item, data, node) {
      var self = this;
      if (!node) {
        return;
      }
      /**
       * We can't start fetching the statistics immediately, it is possible -
       * the user is just using keyboards to select the node, and just
       * traversing through.
       *
       * We will wait for some time before fetching the statistics for the
       * selected node.
       **/
      if (self.timeout) {
        clearTimeout(self.timeout);
      }
      self.timeout = setTimeout(
        function() {
          self.__updateCollection.call(
            self, node.generate_url(item, 'stats', data, true), node, item, data._type
          );
        }, 400);
    },

    __createMultiLineStatistics: function(data, prettifyFields) {
      var rows = data['rows'],
        columns = data['columns'];

      this.columns = [];
      for (var idx in columns) {
        var rawColumn = columns[idx],
          cell_type = typeCellMapper[rawColumn['type_code']] || 'string';

        // Don't show PID comma separated
        if (rawColumn['name'] == 'PID') {
          cell_type = cell_type.extend({
            orderSeparator: '',
          });
        }

        var col = {
          editable: false,
          name: rawColumn['name'],
          cell: cell_type,
        };
        if (_.indexOf(prettifyFields, rawColumn['name']) != -1) {
          col['formatter'] = SizeFormatter;
        }
        this.columns.push(col);

      }

      this.collection.reset(rows.splice(0, 50));
    },

    __loadMoreRows: function() {
      let elem = $('.pg-panel-statistics-container').closest('.wcFrameCenter')[0];
      if ((elem.scrollHeight - 10) < elem.scrollTop + elem.offsetHeight) {
        var rows = this.data['rows'];
        if (rows.length > 0) {
          this.collection.add(rows.splice(0, 50));
        }
      }
    },

    __createSingleLineStatistics: function(data, prettifyFields) {
      var row = data['rows'][0],
        columns = data['columns'],
        res = [],
        name;

      this.columns = this.statistic_columns;
      for (var idx in columns) {
        name = (columns[idx])['name'];
        res.push({
          'statistics': name,
          // Check if row is undefined?
          'value': row && row[name] ?
            ((_.indexOf(prettifyFields, name) != -1) ?
              sizePrettify(row[name]) : row[name]) : null,
        });
      }

      this.collection.reset(res);
    },
  });

  return pgBrowser.NodeStatistics;
});
