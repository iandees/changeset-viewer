'use strict';
var request = require('request');
var queue = require('queue-async');
var moment = require('moment');
var DOMParser = require('xmldom').DOMParser;

var osmXmlToObject = function (elem) {
    var obj = {
        'id': parseInt(elem.getAttribute('id')),
        'version': parseInt(elem.getAttribute('version')),
        'kind': elem.nodeName,
        'tags': {},
        'timestamp': moment(elem.getAttribute('timestamp'), 'YYYY-MM-DDTHH:mm:ssZ'),
    };

    obj.key = obj.kind[0] + obj.id + '@' + obj.version;
    var tagElems = elem.getElementsByTagName('tag');
    for (var i = 0; i < tagElems.length; i++) {
        var key = tagElems[i].getAttribute('k');
        var value = tagElems[i].getAttribute('v');
        obj.tags[key] = value;
    }

    if (obj.kind === 'node') {
        obj['lat'] = parseFloat(elem.getAttribute('lat'));
        obj['lon'] = parseFloat(elem.getAttribute('lon'));
    } else if (obj.kind === 'way') {
        var ndElems = elem.getElementsByTagName('nd');
        obj['nodes'] = [];
        for (i = 0; i < ndElems.length; i++) {
            obj.nodes.push(parseInt(ndElems[i].getAttribute('ref')));
        }
    } else if (obj.kind === 'relation') {
        var memberElems = elem.getElementsByTagName('member');
        obj['members'] = [];
        for (i = 0; i < memberElems.length; i++) {
            var type = memberElems[i].getAttribute('type');
            var ref = parseInt(memberElems[i].getAttribute('ref'));
            var role = memberElems[i].getAttribute('role');
            obj.members.push({
                'type': type,
                'ref': ref,
                'role': role
            });
        }
    }
    return obj;
};

module.exports = function (changesetId) {
    var the_queue = queue(4);
    var changeset = { 'create': [], 'modify': [], 'delete': [] };
    var objects = {};

    var backfillObjectVersion = function(kind, id, version) {
        console.log('https://openstreetmap.org/api/0.6/' + kind + '/' + id + '/' + version);
        request.get({ url: 'https://openstreetmap.org/api/0.6/' + kind + '/' + id + '/' + version }, function(error, response, body) {
            var doc = new DOMParser().parseFromString(body);
            var object = osmXmlToObject(doc.documentElement.childNodes[1]);
            objects[object.key] = object;
            console.log('Storing ' + object.key);
        });
    };

    var backfillObjectHistory = function(kind, id) {
        console.log('https://openstreetmap.org/api/0.6/' + kind + '/' + id + '/history');
        request.get({ url: 'https://openstreetmap.org/api/0.6/' + kind + '/' + id + '/history' }, function(error, response, body) {
            var doc = new DOMParser().parseFromString(body);
            var versions = doc.documentElement.getElementsByTagName(kind);
            for (var i = 0; i < versions.length; i++) {
                var object = osmXmlToObject(versions[i]);
                objects[object.key] = object;
                console.log('Storing ' + object.key);
            }
        });
    };

    var parseChangeset = function(xml) {
        var doc = new DOMParser().parseFromString(xml);
        ["create", "modify", "delete"].forEach(function(mode) {
            var sections = doc.documentElement.getElementsByTagName(mode);
            for (var n=0; n<sections.length; n++) {
                var child = sections[n].firstChild;
                while(child) {
                    var object;
                    if (child.nodeName === 'node') {
                        object = osmXmlToObject(child);
                        objects[object.key] = object;

                        console.log('Storing ' + object.key);

                        if (object.version > 1) {
                            the_queue.defer(backfillObjectVersion, 'node', object.id, object.version - 1);
                        }
                    } else if (child.nodeName === 'way') {
                        object = osmXmlToObject(child);
                        objects[object.key] = object;

                        console.log('Storing ' + object.key);

                        if (object.version > 1) {
                            the_queue.defer(backfillObjectVersion, 'way', object.id, object.version - 1);
                        }

                        object.nodes.forEach(function(nid) {
                            the_queue.defer(backfillObjectHistory, 'node', nid);
                        });
                    } else if (child.nodeName === 'relation') {
                        object = osmXmlToObject(child);

                        console.log('Storing ' + object.key);

                        if (object.version > 1) {
                            the_queue.defer(backfillObjectVersion, 'relation', object.id, object.version - 1);
                        }

                        object.members.forEach(function(member) {
                            the_queue.defer(backfillObjectHistory, member.type, member.ref);
                        });
                    }
                    child = child.nextSibling;
                }
            }
        });
    };

    request.get({ url: 'https://openstreetmap.org/api/0.6/changeset/' + changesetId + '/download' }, function(error, response, body) {
        the_queue
            .defer(parseChangeset, body)
            .awaitAll(function(error, results) { console.log("all done!"); });
    });

};