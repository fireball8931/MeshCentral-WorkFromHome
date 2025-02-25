/** 
* @description MeshCentral-WorkFromHome database module
* @author Ryan Blenis
* @copyright Ryan Blenis 2020
* @license Apache-2.0
*/

"use strict";
var Datastore = null;
var formatId = null;

module.exports.CreateDB = function(meshserver) {
    var obj = {};
    var NEMongo = require(__dirname + '/nemongo.js');
    obj.dbVersion = 1;
    
    obj.initFunctions = function () {
        obj.updateDBVersion = function(new_version) {
            return obj.file.updateOne({type: "db_version"}, { $set: {version: new_version} }, {upsert: true})
                .catch(err => { console.error("Error updating DB version:", err); throw err; });
        };
        
        obj.getDBVersion = function() {
            return new Promise(function(resolve, reject) {
                obj.file.find({ type: "db_version" }).project({ _id: 0, version: 1 }).toArray(function(err, vers){
                    if (err) {
                        console.error("Error getting DB version:", err);
                        reject(err);
                    } else {
                        if (vers.length == 0) resolve(1);
                        else resolve(vers[0]['version']);
                    }
                });
            });
        };

        obj.update = function(id, args) {
            id = formatId(id);
            return obj.file.updateOne({ _id: id }, { $set: args })
                .catch(err => { console.error("Error updating record:", err); throw err; });
        };
        obj.delete = function(id) {
            id = formatId(id);
            return obj.file.deleteOne({ _id: id })
                .catch(err => { console.error("Error deleting record:", err); throw err; });
        };
        obj.get = function(id) {
            if (id == null || id == 'null') return new Promise(function(resolve, reject) { resolve([]); });
            id = formatId(id);
            return obj.file.find({ _id: id }).toArray()
                .catch(err => { console.error("Error getting record:", err); throw err; });
        };
        obj.getMaps = function(nodeId) {
            return obj.file.find({ fromNode: nodeId, type: 'portMap' }).toArray()
                .catch(err => { console.error("Error getting maps:", err); throw err; });
        };
        obj.addMap = function(user, fromNode, toNode, rdplabel, aadcompat) {
            return obj.file.insertOne({
                type: 'portMap',
                fromNode: fromNode,
                toNode: toNode,
                port: 3389,
                localport: 0,
                auto: false,
                user: user,
                rdplabel: rdplabel,
                aadcompat: aadcompat
            }).catch(err => { console.error("Error adding map:", err); throw err; });
        };
        obj.getAllMaps = function(nodeScope) {
            return obj.file.find({ fromNode: { $in: nodeScope }, type: 'portMap' }).toArray()
                .catch(err => { console.error("Error getting all maps:", err); throw err; });
        };
        obj.getRdpLinksForUser = function(userId) {
            return obj.file.find({ type: 'portMap', user: userId, rdplink: true }).toArray()
                .catch(err => { console.error("Error getting RDP links for user:", err); throw err; });
        };

    };
    
    if (meshserver.args.mongodb) {
      require('mongodb').MongoClient.connect(meshserver.args.mongodb, { useNewUrlParser: true, useUnifiedTopology: true }, function (err, client) {
          if (err != null) { console.log("Unable to connect to database: " + err); process.exit(); return; }
          
          var dbname = 'meshcentral';
          if (meshserver.args.mongodbname) { dbname = meshserver.args.mongodbname; }
          const db = client.db(dbname);
          
          obj.file = db.collection('plugin_workfromhome');
          obj.file.indexes(function (err, indexes) {
              var indexesByName = {}, indexCount = 0;
              for (var i in indexes) { indexesByName[indexes[i].name] = indexes[i]; indexCount++; }
              if ((indexCount != 1)) {
                  console.log('Resetting plugin (WorkFromHome) indexes...');
                  obj.file.dropIndexes(function (err) {
                  }); 
              }
          });
          
          if (typeof require('mongodb').ObjectID == 'function') {
              formatId = require('mongodb').ObjectID;
          } else {
              formatId = require('mongodb').ObjectId;
          }
          obj.initFunctions();
    });  
    } else {
        Datastore = require('@yetzt/nedb');
        if (obj.filex == null) {
            obj.filex = new Datastore({ filename: meshserver.getConfigFilePath('plugin-workfromhome.db'), autoload: true });
            obj.filex.persistence.setAutocompactionInterval(40000);
        }
        obj.file = new NEMongo(obj.filex);
        formatId = function(id) { return id; };
        obj.initFunctions();
    }
    
    return obj;
}