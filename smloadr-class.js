const router = require('express').Router();
let smloadr = require('../smloadr/smloadr-class');
const fs = require('fs');
const path = require('path');
let archiver = require('archiver');
let sanitize = require('sanitize-filename');
let querystring = require('querystring');
const axios = require('axios');
const Promise = require('bluebird');
const {mongoError, downloadError, fsError} = require('../utils/error');
// const sqlite3 = require('sqlite3').verbose(); for opening plex database and getting the "key" of a media file based on the path/file location

const SongMatch = require('../models/songMatch.model');
const Playlist = require('../models/playlist.model');

const CONFIG = require('../../src/config.json');
const { resolve } = require('path');
const concurrentDownloads = CONFIG.concurrentDownloads;
const optimizedFS = CONFIG.optimizedFS

const baseurl = 'http://localhost:8888'; //baseurl for API queries

let currentlySyncingPlaylists = false;

//spotify API limits
const spotifyLimit = 100;

//smloadr settings
const rootFolder = smloadr.setDownloadPath(CONFIG.downloadLocation);
const arl = CONFIG.arl;
smloadr.createNewToken(arl)
.then(msg => { console.log(msg) })

const quality = CONFIG.quality;
smloadr.setMusicQuality(quality)
.then(result => { console.log(result) })

// download a single track, required: deezerID 
router.route('/track').get( async (req, res) => {
  let deezerID = req.query.deezerID ? req.query.deezerID : null,
      playlistID = req.query.playlistID ? req.query.playlistID : null;

  if (!deezerID || typeof optimizedFS !== "boolean") return res.json({error: "Missing parameter"});

  if (optimizedFS && !playlistID) return res.json({error: "Can not download single track with optimizedFS enabled"}); // this needs to be possible
  
  try {
    await axios.get("https://deezer.com/us/track/"+deezerID) // try if the track is available

    let resMatch = await SongMatch.findOne({deezerID})

    if (!playlistID) { // download a track without a playlistid
      const exists = await doesTrackExist(resMatch);

      if (exists) return res.json({success: "Track already exists"});

      let msg;

      if (optimizedFS) {
        msg = await downloadForPlex(deezerID, resMatch)
      } else {
        msg = await downloadTrack(deezerID)
      }

      msg += "- No playlist?"
      return res.json({success: msg})
    }

    if (!resMatch) throw new mongoError("no result", "Songmatch", deezerID); // if no playlistID was provided we dont NEED the resMatch

    let resPlaylist = await Playlist.findOne({playlistID})
    if (!resPlaylist) throw new mongoError("no result", "Playlist", playlistID);
    
    playlistTitle = resPlaylist.playlistTitle;

    let exists = await doesTrackExist(resMatch, playlistTitle)
    if (exists) return res.json({success: "Track already exists"});

    let msg;

    if (optimizedFS) { // download track to ./artist/album folder
      msg = await downloadForPlex(deezerID, resMatch)
    } else { // download track to playlist folder
      msg = await downloadTrack(deezerID, playlistTitle, resMatch)
    }

    resPlaylist.lastDownload = Date();
       
    resPlaylist.save()
    .then(() => { return res.json({success: msg}) })
    .catch(err => { throw new mongoError("update", "Playlist", "lastDownload") })
  } catch (err) {
    //console.error(err)

    if (err instanceof mongoError) { // mongo error
      if (err.message === "no result") return res.json({error: `could not find "${err.key}" in ${err.collection}`})
      if (err.message === "update") return res.json({error: `could not update "${err.key}" in ${err.collection}`})
      if (err.message === "save") return res.json({error: `could not save new document ${err.collection}`})

    } else if (err instanceof fsError) {
      return res.json({error: error.message})

    } else if (err instanceof downloadError) {
      if (err.message.includes("track not available")) {
        setBadMatch(deezerID)
        .then(() => { return res.json({error: `Track ${deezerID} is not available`}) })
        .catch(err => { return res.json({error: `Track ${deezerID} is not available`}) })
      } else {
        return res.json({error: err})
      }
    } else if (err.isAxiosError) {
      //res.json({error: "axios error "+err.response.status})
      setBadMatch(deezerID)
      .then(() => { return res.json({error: `Track ${deezerID} is not available`}) })
      .catch(err => {
        throw err
        res.json({error: `Track ${deezerID} is not available`})
      })
    } else {
      console.error(err)
      return res.json({error: "unknown error"})
    }
  }
})

// used to download a zip file of all tracks in a playlist
router.route('/playlist').get((req, res) => {
  let playlistID = req.query.playlistID;
  let optimizedFS = CONFIG.optimizedFS;

  Playlist.findOne({playlistID})
  .then(resPlaylist => {
    if (!result) throw new mongoError("no result", "Playlist", playlistID);

    let archivePath = path.join(rootFolder, resPlaylist.playlistTitle+".zip");
    playlistTitle = optimizedFS === false ? resPlaylist.playlistTitle : false; 

    let archiveExists = fs.access(archivePath, err => {
      if (err) {
        return false
      } else {
        return true
      }
    })

    if (!CONFIG.allowUploads) {
      return res.json({success: "Uploading to system not allowed"})
    } else if (resPlaylist.lastZip > resPlaylist.lastDownload && archiveExists) { //fs.existsSync(archivePath)
      console.log(`Archive ${playlistTitle} already exists`)
      return res.download(archivePath);
    } else {
      let tracks = [];

      Promise.map(resPlaylist.tracks, spotifyID => {
        return SongMatch.findOne({spotifyID})
        .then(resMatch => {
          for (let i = 0; i < resMatch.location.length; i++) {
            fs.access(resMatch.location[i], err => {
              if (!err) {
                tracks.push(resMatch.location[i])
                return resolve()
              }
            })
          }
        })
        .catch(() => { return resolve() })
      })

      /*let tasks = resPlaylist.tracks.map(spotifyID => {
        return new Promise(resolve => {
          SongMatch.findOne({spotifyID})
          .then(resMatch => {
            tracks.push(...resMatch.location);
            resolve()
          })
        })
      })

      Promise.all(tasks)*/
      .then(() => {
        createArchive(playlistTitle, tracks, archivePath)
        .then(archivePath => {
          resPlaylist.lastZip = Date();

          resPlaylist.save()
          .then(() => { return res.download(archivePath) })
          .catch(err => {
            console.error(err);
            return res.json({error: "Could not update lastZip date"});
          })
        })
        .catch(err => {
          console.error(err)
          return res.json({error: "could not create playlist"})
        })
      })
    }
  })
  .catch(err => {
    if (err !== "no result") console.error(err);
    return res.json({error: "Could not find playlist"});
  })
});

// update playlist settings; sync, removedTracks
router.route('/update-playlist-settings').post((req, res) => {
  let playlistID = req.body.playlistID,
      sync = req.body.sync,
      removedTracks = req.body.removedTracks;

  if (typeof playlistID === "undefined" || typeof sync === "undefined" || typeof removedTracks === "undefined") return res.json({error: "missing parameter"});

  Playlist.findOne({playlistID})
  .then(result => {
    if (!result) throw "no result";

    result.sync = sync;
    result.removedTracks = removedTracks;

    result.save()
    .then(() => { return res.json({success: "updated playlist settings"}) })
    .catch(err => {
      console.error("could not update playlist settings", err)
      return res.json({error: "could not update playlist settings"})
    })
  })
  .catch(err => {
    if (err !== "no result") console.error(err)
    return res.json({error: "no result"})
  })
});

// return the settings for a playlist; sync, removedTracks
router.route('/get-playlist-settings').get((req, res) => {
  let playlistID = req.query.playlistID;

  Playlist.findOne({playlistID})
  .then(result => {
    if (!result) throw "no result";

    let sync = false,
        removedTracks = result.removedTracks;

    if (result.sync) sync = true;

    return res.json({sync, removedTracks})
  })
  .catch(err => {
    if (err !== "no result") console.error(err)
    return res.json({error: "no result"})
  })
});

/**
 * check if the track was already downloaded
 * 
 * @param {Object} resMatch mongoose query result
 * @param {String} playlistTitle title of the playlist
 */
let doesTrackExist = (resMatch, playlistTitle = undefined) => {
  return new Promise(resolve => {
    if (!resMatch) return resolve(false);

    if (optimizedFS) {
      fs.access(resMatch.location[0], err => {
        if (!err) {
          return resolve(true)
        } else {
          resMatch.location = undefined; // Delete the location array from the mongo document

          resMatch.save()
          .then(() => {return resolve(false) })
          .catch(() => {return resovle(false) })
        }
      })
    }

    let exists = false;
    let locations = [];

    Promise.map(resMatch.location, (location, index) => {
      return new Promise(resolve => {
        if (locations.includes(location)) {
          resMatch.location.splice(index, 1) // splice location if it is a double
          return resolve()
        } else {
          locations.push(location)
        }

        if (location.includes("/"+playlistTitle+"/") || !playlistTitle) {
          fs.access(location, err => {
            if (err) {
              resMatch.location.splice(index, 1)  // splice location if the track was removed from system
            } else {
              exists = true 
            }
            resolve()
          })
        } else {
          resolve() 
        }
      })
    }, {concurrency: 1})
    .then(() => {
      resMatch.save() // update location array in mongo, all duplicates and removed tracks should have been spliced/removed
      .then(() => { return resolve(exists) })
      .catch(() => { return resolve(exists) })
    })
  })
}

/**
 * create a archive for a folder
 * 
 * @param {String} playlistTitle 
 * @param {Array} tracks 
 * @param {String} archivePath 
 */
let createArchive = (playlistTitle, tracks, archivePath) => {
  let output = fs.createWriteStream(archivePath);

  var archive = archiver('zip', {
    zlib: { level: 9 } // Sets the compression level.
  });

  return new Promise((resolve, reject) => {
    // listen for all archive data to be written
    // 'close' event is fired only when a file descriptor is involved
    output.on('close', function() {
      console.log(archive.pointer() + ' total bytes');
      return resolve(archivePath);
    });

    // This event is fired when the data source is drained no matter what was the data source.
    // It is not part of this library but rather from the NodeJS Stream API.
    // @see: https://nodejs.org/api/stream.html#stream_event_end
    output.on('end', function() {
      console.log('Data has been drained');
      return resolve(archivePath)
    });

    // good practice to catch warnings (ie stat failures and other non-blocking errors)
    archive.on('warning', function(err) {
      if (err.code === 'ENOENT') {
        // log warning
      } else {
        // throw error
        reject(err)
        throw err;
      }
    });

    // good practice to catch this error explicitly
    archive.on('error', function(err) {
      reject(err)
      throw err;
    });

    // pipe archive data to the response
    archive.pipe(output);

    if (playlistTitle) { // archive a folder
      archive.directory(path.join(rootFolder, playlistTitle), false);
      archive.finalize();
    } else { // archive seperate tracks
      let tasks = tracks.map(location => {
        return new Promise(resolve => {
          fs.access(location, err => {
            if (err) {
              console.log(location, "Could not be found")
            } else {
              archive.file(location, {name: path.basename(location)})
            }
            return resolve()
          })
        })
      })

      Promise.all(tasks)
      .then(() => { archive.finalize() })
    }
  });
}

/**
 * move a file
 * 
 * @param {String} trackLocation 
 * @param {String} newTrackLocation 
 */
let moveToPlaylist = (trackLocation, newTrackLocation) => {
  return new Promise((resolve, reject) => {
    fs.access(trackLocation , err => {
      if (err) {
        throw new fsError(`could not move ${trackLocation}`);
      } else {
        fs.rename(trackLocation, newTrackLocation, (err) => {
          if (err) console.error(err);
          return resolve();
        })
      }
    })
  })
}

/**
 * download track using smloadr lib 
 * the tracks will be stored in ./artist/album
 * the location of the track is stored in mongoDB
 * 
 * @param {String} deezerID 
 * @param {Object} resMatch result of mongoDB query
 */
let downloadForPlex = (deezerID, resMatch) => {
  return new Promise( async (resolve, reject) => {
    try {
      const msg = await smloadr.startDownload(deezerID, arl)

      if (msg.saveFilePath) {//If the song was already downloaded it won't return a filePath
        if (!resMatch) return resolve(msg.msg)  
      
        resMatch.location = msg.saveFilePath

        resMatch.save()
        .then(() => { return resolve(msg.msg) })
        .catch(err => { throw new mongoError("update", "Songmatch", "location") })
      } else {
        return resolve(msg.msg);
      }
    } catch (err) {
      return reject(err);
    }
  })
}

/**
 * download a track using the smloadr lib and move it to the correct folder based on playlistTitle
 * the location is stored in mongoDB
 * 
 * @param {String} deezerID 
 * @param {String} playlistTitle 
 * @param {Object} resMatch result from mongoDB query
 */
let downloadTrack = (deezerID, playlistTitle = null, resMatch = null) => {
  return new Promise( async (resolve, reject) => {
    try {
      const msg = await smloadr.startDownload(deezerID, arl)

      if (msg.saveFilePath && playlistTitle) { // if a playlisttitle was given the file should be moved and stored in the DB, also if no saveFilePath was returned it was already downloaded 
        let trackLocation = msg.saveFilePath;
        let playlistLocation = path.join(path.dirname(msg.saveFilePath), playlistTitle);
        let newTrackLocation = path.join(playlistLocation, path.basename(msg.saveFilePath));

        await createNewFolder(playlistLocation)
        await moveToPlaylist(trackLocation, newTrackLocation)

        if (!resMatch) return resolve(msg.msg);

        resMatch.location = resMatch.location ? [...resMatch.location, newTrackLocation] : newTrackLocation;
        resMatch.save()
        .then(() => {
          return resolve(msg.msg);
        })
        .catch(()=> {
          throw new mongoError("update", "Songmatch", "location")
        })
      } else {
        return resolve(msg.msg);
      }
    } catch (err) {
      return reject(err)
    }
  })
}

let createNewFolder = (folder) => {
  return new Promise((resolve, reject) => {
    fs.mkdir(folder, {recursive: true, mode: 0o666}, err => {
      if (err) {
        throw new fsError(`could not create ${folder}`)
      } else {
        return resolve()
      }
      /* possibly needed on windows but unnecessary in linux
         mode option in fs.mkdir is not supported on windows
      fs.chmod(folder, 0o666, err => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })*/
    })
  })
}

// some day this function will be used to track or immediately add the song to plex 
// also requires sqlite3 library to connect to plex database
let addToPlexPlaylist = () => {
  let db = new sqlite3.Database('./db/chinook.db');

  let sql = `SELECT id file FROM media_parts WHERE file LIKE '%Bootlegs%' ORDER BY id`;

  db.all(sql, [], (err, rows) => {
    if (err) {
      throw err;
    }
    rows.forEach((row) => {
      console.log(row);
    });
  });

  // close the database connection
  db.close();
}

let setBadMatch = (deezerID) => {
  console.warn("setting badmatch", deezerID)
  return new Promise((resolve, reject) => {
      SongMatch.findOne({deezerID})
      .then(result => {
        if (!result) throw new mongoError("no result", "Songmatch", deezerID)

        result.deezerID = "badmatch";
        result.manual = true;

        result.save()
        .then(() => { return resolve() })
        .catch(err => { throw new mongoError("update", "Songmatch", "badmatch") })
      })
      .catch(err => { return reject(err) })
  })
}

//!!! Here will start the functions for automatic downloading and syncronizing the selected playlists

/**
 * synchronizes all playlists that have sync: true in mongodb
 * all tracks will be downloaded 
 * depending on removedTracks: {0,1,2} the removed tracks can be downloaded, deleted or kept
 */
let syncPlaylist = () => {
  if (currentlySyncingPlaylists) return; // do not synchronize again if the previous sync is still going, this should only happen when really large amounts of songs need to be synced
  
  currentlySyncingPlaylists = true;

  Playlist.find({sync: true}) // find all playlists that need to be synced
  .then(result => {
    if (!result) throw "no playlists have to be synchronized"; // if the result is null there are no results, and thus no playlists should be synced

    Promise.map(result, playlist => { // do the following for each playlist
      return new Promise( async (resolve, reject) => {
        const playlistID = playlist.playlistID;
        //if (!playlist.playlistTitle.includes("40 Mix")) return resolve()

        console.log(playlist.playlistTitle, "will be synced");
        
        try {
          const spotifyToken = await getSpotifyToken();
          const tracks = await getPlaylistTracks(playlistID, spotifyToken);
          const playlistTitle = await getPlaylistTitle(playlistID, spotifyToken);
          
          await storePlaylistToDB(tracks, playlistTitle, playlistID)
          await matchMultipleTracks(tracks, spotifyToken)

          await Promise.map(tracks, track => sendTrackToAPI(track, playlistID, playlistTitle), {concurrency: concurrentDownloads})

          if (playlist.removedTracks === 1) { // download removed tracks
            await Promise.map(playlist.deletedTracks, track =>  sendTrackToAPI(track, playlistID), { concurrency: concurrentDownloads })
          } else if (playlist.removedTracks === 2) { // delete removed tracks
            await deleteRemovedTracks(playlistID)
            console.log(playlistTitle, "has been downloaded")
          } 

          return resolve()
        } catch (err) {
          return reject(err)
        }
      })
    }, {concurrency: 1})
    .then(() => {
      currentlySyncingPlaylists = false;
      console.log("Finished syncing all playlists!")
      SongMatch.find({deezerID: "badmatch"})
      .then(result => {
        if (!result) throw "0 badmatch tracks"

        console.log(result.length, "badmatch tracks")
      })
      .catch(err => { console.error(err) })
    })
  })
  .catch(err => {
    currentlySyncingPlaylists = false;
    if (err !== "no result") console.error(err)
  })
}

/**
 * delete all tracks that still exist on disk but were removed from playlist
 * 
 * @param {*} tracks 
 */
let deleteRemovedTracks = (playlistID) => {
  return new Promise(resolve => {
    Playlist.findOne({playlistID})
    .then(result => {
      if (!result) throw "no result";

      let playlistTitle = result.playlistTitle;

      if (result.deletedTracks) {
        Promise.map(result.deletedTracks, spotifyID => {
          SongMatch.findOne({spotifyID})
          .then(result => {
            if (!result) throw "no result"

            let locationIndex = null;
            result.location.filter((location, i) => {if (location.includes(playlistTitle)) locationIndex = i;}); // get the index of the location where the playlist title occurs
            if (locationIndex !== null) {
              let file = result.location[locationIndex]; // get the file location using locationIndex
              fs.unlink(file, err => {
                if (err) {
                  console.error(err)
                  return resolve()
                }

                result.location.splice(locationIndex, 1);
              
                result.save()
                .then(() => {
                  console.log("deleted", file)
                  return resolve()
                })
                .catch(err => {
                  console.error("could not remove location from database", spotifyID, err)
                  return resolve()
                })
              })
            }
          })
          .catch(err => {
            if (err !== "no result") console.error("could not delete removed track", spotifyID, err);
            return resolve()
          })
        }, {concurrency: 1})
        .then(() => { return resolve() })
      } else {
        return resolve()
      }
    })
    .catch(err => {
      if (err !== "no result") console.error(err)
      return resolve()
    })
  })
}

/**
 * match all tracks in the array (useful for playlists)
 * 
 * @param {Array} tracks 
 * @param {String} spotifyToken 
 */
let matchMultipleTracks = (tracks, spotifyToken) => {
  return Promise.map(tracks, spotifyID => {
    return SongMatch.findOne({spotifyID})
      .then(result => {
        if (!result) {
          console.log("missing track", spotifyID)
    
          return getSpotifyTrackInfo(spotifyID, spotifyToken)
          .then(trackinfo => {
            const query = generateDataString(trackinfo);
            return matchTrack(spotifyID, query, trackinfo.isrc)
            .catch(err => { console.error(err) })
          })
          .catch(err => { console.error(err) })
        }
      })
      .catch(err => { console.error(err) }) 
    }, {concurrency: 1})
}

/**
 * request the spotifyAPItoken for a user using this application's API
 * 
 * @param {String} name
 * 
 * @returns spotifyAPItoken 
 */
let getSpotifyToken = (name = 'Luc') => { // name should not be implied
  return new Promise((resolve, reject) => {
    axios.get(baseurl+'/api/spotify/gettoken?'+querystring.stringify({name}))
    .then(response => { return resolve(response.data.token) })
    .catch(err => { return reject(err) })
  })
}

/**
 * returns info about track
 * 
 * @param {String} spotifyID trackID for spotify
 * @param {String} spotifyToken personal API token
 * 
 * @returns {Object} trackinfo
 */
let getSpotifyTrackInfo = (spotifyID, spotifyToken) => {
  return new Promise((resolve, reject) => {
    axios.get('https://api.spotify.com/v1/tracks/'+spotifyID, {
      headers: {Authorization: 'Bearer '+spotifyToken}
    })
    .then(response => { return resolve({title: response.data.name, artists: response.data.artists, isrc: response.data.external_ids.isrc}) })
    .catch(err => { return reject(err) })
  })
}

/**
 * generate the search query string for deezer
 * 
 * @param {Object} track contains title and array of artists
 * 
 * @returns {String} query for /api/match/advancedsearch route
 */
let generateDataString = (track) => {
  //remove any "featuring" and other extra's from trackname for better search results
  let n = () => {
    let bracket = track.title.indexOf(' ('),
        dash = track.title.indexOf(' - ');
    if (bracket > dash) {
      return bracket;
    } else {
      return dash;
    } 
  }

  let title = n(track.title) === -1 ? track.title : track.title.substring(0, n(track.title));
   
  let query = `track:"${title}" `;

  // add artists to search query
  for (let i = 0; i < track.artists.length; i++) query += `artist:"${track.artists[i].name}" `;
  
  return query;
}

/**
 * 
 * @param {string} spotifyID 
 * @param {Object} query 
 * @param {String} isrc 
 */
let matchTrack = (spotifyID, query, isrc) => {
  return new Promise((resolve, reject) => {
    axios.get(baseurl+'/api/match/advancedsearch?'+querystring.stringify({query, spotifyID, isrc}))
    .then(response => {
      if (response.data.error) throw response.data.error;
      return resolve();
    })
    .catch(err => { return reject(err) })
  })
}

/**
 * get the title of a spotify playlist
 * 
 * @param {String} playlistID 
 * @param {String} spotifyToken 
 * 
 * @returns {String} the playlist title
 */
getPlaylistTitle = (playlistID, spotifyToken) => {
  return new Promise((resolve, reject) => {
    axios.get(`https://api.spotify.com/v1/playlists/${playlistID}`, {
      headers: {Authorization: 'Bearer '+spotifyToken}
    })
    .then(response => { return resolve(response.data.name) })
    .catch(err => { return reject(err) })
  })
}

/**
 * get id from all tracks in a playlist
 * 
 * @param {String} playlistID 
 * @param {String} spotifyToken 
 * @param {Number} offset
 * @param {Array} tracks 
 * 
 * @returns {Array} array of trackIDs in the playlist
 */
let getPlaylistTracks = (playlistID, spotifyToken, offset = 0, tracks = new Array) => {
  return new Promise((resolve, reject) => {
    axios.get(`https://api.spotify.com/v1/playlists/${playlistID}/tracks?`+querystring.stringify({limit: spotifyLimit, offset}), { // get trackID to update the playlist
      headers: {Authorization: 'Bearer '+spotifyToken}
    })
    .then(response => {
      for (let i = 0; i < response.data.items.length; i++) {
        if (response.data.items[i].track) tracks.push(response.data.items[i].track.id); // for some weird reason 'track' can be null and results in a error here
      }

      offset += spotifyLimit;

      if (response.data.items.length === spotifyLimit) {
        getPlaylistTracks(playlistID, spotifyToken, offset, tracks)
        .then(tracks => {
          return resolve(tracks);
        })
      } else {
        return resolve(tracks)
      }
    })
    .catch(err => {
      if (err.status === 401) {
        getSpotifyToken()
        .then(spotifyToken => {
          return getPlaylistTracks(playlistID, spotifyToken, offset, tracks)
        })
      } else {
        return reject(err); 
      }  
    })
  })
}

/**
 * Update the playlist in database, the trackID and playlistTitle should be retrieved using getPlaylistTracks()
 * 
 * @param {Array} trackID 
 * @param {String} playlistTitle 
 * @param {String} playlistID
 */
let storePlaylistToDB = (trackID, playlistTitle, playlistID) => {
  return new Promise((resolve, reject) => {
    axios.post(baseurl+'/api/match/storeplaylist', {
      trackID, playlistTitle, playlistID
    })
    .then(response => {
      if (response.data.error) throw response.data.error;
      return resolve()
    })
    .catch(err => { return reject(err) })
  })
}

/**
 * Download the track from deezer that belongs to the spotifyID
 * 
 * @param {String} spotifyID 
 * @param {String} playlistID 
 */
let sendTrackToAPI = (spotifyID, playlistID, playlistTitle) => {
  return new Promise(resolve => {
    SongMatch.findOne({spotifyID})
    .then(async result => {
      if (!result) return resolve();

      let deezerID = result.deezerID;

      const exists = await doesTrackExist(result, playlistTitle);
      if (exists) return resolve()

      if (deezerID === "badmatch") return resolve(); // its known this track is not available 

      axios.get(baseurl+'/api/download/track?'+querystring.stringify({deezerID, playlistID}))
      .then(result => {
        if (result.data.error) throw result.data.error

        return resolve()
      })
      .catch(err => {
        if (!err.includes(deezerID)) console.error(err)

        return resolve()
      })
    })
  })
}

setTimeout(syncPlaylist, 15 * 1000); // wait 15 seconds before starting sync
setInterval(syncPlaylist, 15 * 60 * 1000); // run function every 15 minutes, use clearInterval(interval) to stop

module.exports = router;
