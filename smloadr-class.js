const Promise = require('bluebird');
const sanitize = require('sanitize-filename');
const id3Writer = require('./libs/browser-id3-writer');
const flacMetadata = require('./libs/flac-metadata');
const fs = require('fs');
const stream = require('stream');
const nodePath = require('path');
const {downloadError, XHRerror} = require('../utils/error')
const querystring = require('querystring')
const EncryptionService = require('./libs/EncryptionService')
let encryptionService = new EncryptionService();

const axios = require('axios').default;
const tough = require('tough-cookie');
const axiosCookieJarSupport = require('axios-cookiejar-support').default;

axiosCookieJarSupport(axios);

const CONFIG = require('../../src/config.json');
const concurrentDownloads = CONFIG.concurrentDownloads;
const optimizedFS = CONFIG.optimizedFS;

const unofficialApiUrl = 'https://www.deezer.com/ajax/gw-light.php?';

let DOWNLOAD_DIR = '/music/';

const musicQualities = {
    MP3_128: {
        id: 1,
        name: 'MP3 - 128 kbps',
        aproxMaxSizeMb: '100'
    },
    MP3_320: {
        id: 3,
        name: 'MP3 - 320 kbps',
        aproxMaxSizeMb: '200'
    },
    FLAC: {
        id: 9,
        name: 'FLAC - 1411 kbps',
        aproxMaxSizeMb: '700'
    },
    MP3_MISC: {
        id: 0,
        name: 'User uploaded song'
    }
};

let selectedMusicQuality = musicQualities.MP3_320;

const delay = t => new Promise(resolve => setTimeout(resolve, t));

let smloadrClass = class {
    constructor() {
        this.tokens = [] // array containing the arl, axios config, and unofficialApiQueries
        this.queue = []; // array of objects containing the track_id and associated arl
        this.active = [] // array with active downloads from the queue, it will also contain track info
    }

    /**
     * Change the download location, default /music
     * 
     * @param {String} downloadLocation path to the download location
     */
    setDownloadPath(downloadLocation) {
        if (downloadLocation.charAt(downloadLocation.length-1) !== "/") downloadLocation += '/';

        DOWNLOAD_DIR = downloadLocation;

        return DOWNLOAD_DIR;
    }

    /**
     * Change the music quality, default MP3_320
     * 
     * @param {String} quality The desired quality, MP3_128 - MP3_320 - FLAC
     */
    setMusicQuality(quality) {
        return new Promise(resolve => {
            switch (quality) {
                case 'MP3_128':
                    selectedMusicQuality = musicQualities.MP3_128;
                    resolve(`set music quality to ${selectedMusicQuality.name}`);
                    break;
                case 'MP3_320':
                    selectedMusicQuality = musicQualities.MP3_320;
                    resolve(`set music quality to ${selectedMusicQuality.name}`);
                    break;
                case 'FLAC':
                    selectedMusicQuality = musicQualities.FLAC;
                    resolve(`set music quality to ${selectedMusicQuality.name}`);
                    break;
                default:
                    resolve(`no valid music quality was given.\nvalid options: MP3_128, MP3_320, FLAC\ndefaulted to ${selectedMusicQuality.name}`);
            }
        })
    }

    /**
     * Get a cid for a unofficial api request.
     *
     * @return {Number}
     */
    getApiCid() {
        return Math.floor(1e9 * Math.random());
    }

    /**
     * Replaces multiple whitespaces with a single one.
     *
     * @param {String} string
     * @returns {String}
     */
    multipleWhitespacesToSingle(string) {
        return string.replace(/[ _,]+/g, ' ');
    }

    /**
     * Replaces multiple whitespaces with a single one.
     *
     * @param {String} fileName
     * @returns {String}
     */
    sanitizeFilename(fileName) {
        fileName = fileName.replace('/', '-');

        return sanitize(fileName);
    }

    /**
     * remove Album Art from system
     *
     * @param {String} albumCoverSavePath
     */
    removeDownloadedArt(albumCoverSavePath) {
        if (albumCoverSavePath && fs.existsSync(albumCoverSavePath)) {
            fs.unlinkSync(albumCoverSavePath);
        }
        return;
    }

    /**
     * Create directories of the given path if they don't exist.
     *
     * @param {String} filePath
     * @return {boolean}
     */
    ensureDir(filePath) {
        const dirName = nodePath.dirname(filePath);

        if (fs.existsSync(dirName)) {
            return true;
        }

        this.ensureDir(dirName);
        fs.mkdirSync(dirName);
    }

    /**
     * Calculate the URL to download the track.
     *
     * @param {Object} trackInfos
     * @param {Number} trackQuality
     *
     * @returns {String}
     */
    getTrackDownloadUrl(trackInfos, trackQuality) {
        const cdn = trackInfos.MD5_ORIGIN[0];

        return 'https://e-cdns-proxy-' + cdn + '.dzcdn.net/mobile/1/' + encryptionService.getSongFileName(trackInfos, trackQuality);
    }

    /**
     * Capitalizes the first letter of a string
     *
     * @param {String} string
     *
     * @returns {String}
     */
    capitalizeFirstLetter(string) {
        return string.charAt(0).toUpperCase() + string.slice(1);
    }

    getTokenNR(arl) {
        let nr = -1;
        
        this.tokens.forEach((token, index) => { if (token.arl === arl) nr = index })

        return nr;
    }

    getActiveNR(track_id) {
        let nr = -1;
        
        this.active.forEach((track, index) => { if (track.track_id === track_id) nr = index })

        return nr;
    }

    createNewToken(arl) {
        if (this.getTokenNR(arl) !== -1) return "arl already exists"

        const httpHeaders = {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.129 Safari/537.36',
            'cache-control': 'max-age=0',
            'accept-language': 'en-US,en;q=0.9,en-US;q=0.8,en;q=0.7',
            'accept-charset': 'utf-8,ISO-8859-1;q=0.8,*;q=0.7',
            'content-type': 'text/plain;charset=UTF-8',
            'cookie': 'arl=' + arl
        }

        const defaultToken = {
            arl,
            config: {
                jar: new tough.CookieJar(),
                withCredentials: true,
                headers: httpHeaders
            },
            unofficialApiQueries: {
                api_version: '1.0',
                api_token: '',
                input: 3
            }
        }

        this.tokens.push(defaultToken)

        return this.initAPI(this.tokens.length-1)
    }

    initAPI(token_nr) {
        return new Promise((resolve, reject) => {
            axios.get(unofficialApiUrl+querystring.stringify(Object.assign({}, this.tokens[token_nr].unofficialApiQueries, {method: 'deezer.getUserData', cid: this.getApiCid()})), this.tokens[token_nr].config)
            .then(response => {
                if (!response || Object.keys(response.data.error).length > 0) {
                    throw response.data.error;
                } else if (response.data.results.USER.USER_ID !== 0) {
                    if (response.data.results && response.data.results.checkForm) {

                        this.tokens[token_nr].unofficialApiQueries.api_token = response.data.results.checkForm;

                        resolve("connected to API")
                    } else {
                        throw "no checkForm";
                    }
                } else {
                    reject("wrong deezer credentials")
                }
            })
            .catch(err => {
                reject(new XHRerror("Could not initialize Deezer API", (err.response ? err.response.status : err)))
            })
        })
    }

    startDownload(track_id = null, arl = null) {
        return new Promise(async (resolve, reject) => {
            if (!track_id || !arl) throw "missing paramater"

            this.queue.push({track_id, arl})

            await this.waitQueue(track_id)

            // push to active and pop from queue
            this.active.push({track_id, arl})
            this.queue.shift()
            
            console.log(track_id, "started downloading")
            console.time(track_id)
            this.processDownload(track_id)
            .then(result => {
                this.active.splice(this.getActiveNR(track_id), 1) // splice the finished track of the active array

                console.timeEnd(track_id)
                resolve(result)
            })
            .catch(err => {
                this.active.splice(this.getActiveNR(track_id), 1) // splice the finished track of the active array

                console.error(track_id, "could not be downloaded")
                console.timeEnd(track_id)
                reject(err)
            })
        })
    }

    /**
     * check if a track is first in queue and active is lower than concurrentDownloads
     * 
     * @param {String} track_id the track id we want to know if it's ready to be queued
     */
    waitQueue(track_id) {
        return new Promise(resolve => {
            if (this.active.length < concurrentDownloads && this.queue[0].track_id === track_id) return resolve() // continue to process download
            delay(100).then(() => {
                this.waitQueue(track_id)
                .then(() => { return resolve() })
            })
        })
    }

    processDownload(track_id, trackInfos = {}, albumInfos = {}, isAlternativeTrack = false) {
        return new Promise(async (resolve, reject) => {
            const nr = this.getActiveNR(track_id)
            const token_nr = this.getTokenNR(this.active[nr].arl)

            // first there should be something with alternative tracks??

            try {
                trackInfos = await this.getTrackInfos(track_id, token_nr)
                let fileExtension = 'mp3'
                let saveFilePath;

                const trackQuality = this.getValidTrackQuality(trackInfos)

                if (!trackQuality) return reject(new downloadError("quality not available"));

                if (trackInfos.ALB_ID !== 0) {
                    albumInfos = await this.getAlbumInfos(trackInfos.ALB_ID, token_nr)
                    ////// wtf is this even. we cant do getAlbumInfos() if there is no album id
                    // if (0 === trackInfos.ALB_ID) {
                    //     const albumInfosOfficial = await this.getAlbumInfosOfficialApi(trackInfos.ALB_ID)

                    //     albumInfos.TYPE = albumInfosOfficial.record_type;

                    //     albumInfosOfficial.genres.data.forEach(albumGenre => { albumInfos.GENRES.push(albumGenre.name) });
                    // }

                    trackInfos.ALB_UPC = '';
                    trackInfos.ALB_LABEL = '';
                    trackInfos.ALB_NUM_TRACKS = '';
                    trackInfos.ALB_NUM_DISCS = '';

                    trackInfos.ALB_ART_NAME = trackInfos.ART_NAME;

                    if (albumInfos.UPC) trackInfos.ALB_UPC = albumInfos.UPC;
                    if (albumInfos.PHYSICAL_RELEASE_DATE && !trackInfos.ALB_RELEASE_DATE) trackInfos.ALB_RELEASE_DATE = albumInfos.PHYSICAL_RELEASE_DATE;
                    if (albumInfos.SONGS && 0 < albumInfos.SONGS.data.length && albumInfos.SONGS.data[albumInfos.SONGS.data.length - 1].DISK_NUMBER) trackInfos.ALB_NUM_DISCS = albumInfos.SONGS.data[albumInfos.SONGS.data.length - 1].DISK_NUMBER;
                    if (trackInfos.ALB_ART_NAME.trim().toLowerCase() === 'various') trackInfos.ALB_ART_NAME = 'Various Artists';
                    if (albumInfos.LABEL_NAME) trackInfos.ALB_LABEL = albumInfos.LABEL_NAME;
                    if (albumInfos.SONGS && albumInfos.SONGS.data.length) trackInfos.ALB_NUM_TRACKS = albumInfos.SONGS.data.length;

                    if (!trackInfos.ARTISTS || 0 === trackInfos.ARTISTS.length) {
                        trackInfos.ARTISTS = [{
                            ART_ID: trackInfos.ART_ID,
                            ART_NAME: trackInfos.ALB_ART_NAME,
                            ART_PICTURE: trackInfos.ART_PICTURE
                        }];
                    }

                    trackInfos.ALB_GENRES = albumInfos.GENRES;

                    if (albumInfos.TYPE) trackInfos.ALB_RELEASE_TYPE = albumInfos.TYPE;
                }

                let artistName = this.multipleWhitespacesToSingle(this.sanitizeFilename(trackInfos.ALB_ART_NAME));
                if (artistName.trim() === '') artistName = 'Unknown artist';

                let albumName = this.multipleWhitespacesToSingle(this.sanitizeFilename(trackInfos.ALB_TITLE));
                if (albumName.trim() === '') albumName = 'Unknown album'; 
                
                if (trackQuality.id === musicQualities.FLAC.id) fileExtension = 'flac';

                if (optimizedFS) {
                    saveFilePath = nodePath.join(DOWNLOAD_DIR, artistName, albumName);
                    let artistPath = nodePath.dirname(saveFilePath)

                    //create artist folder if it does not exist
                    if(!fs.existsSync(artistPath)) {
                        fs.mkdirSync(artistPath);
                        fs.chmodSync(artistPath, 0o666); //folders created by node are created by the user node was started with, I run my application with root so change permissions
                    } 

                    //create album folder if it does not exist
                    if(!fs.existsSync(saveFilePath)) {
                        fs.mkdirSync(saveFilePath);
                        fs.chmodSync(saveFilePath, 0o666); //folders created by node are created by the user node was started with, I run my application with root so change permissions
                    } 

                    saveFilePath += "/";
                } else {
                    saveFilePath = DOWNLOAD_DIR;
                }                    

                saveFilePath += artistName + ' - ' + this.multipleWhitespacesToSingle(this.sanitizeFilename(trackInfos.SNG_TITLE_VERSION)) + '.' + fileExtension;

                if (fs.existsSync(saveFilePath)) return resolve({msg: ", track already exists"}); // do not download again if the track already exists
                
                const decryptedTrackBuffer = await this.downloadTrack(trackInfos, trackQuality.id, saveFilePath, token_nr)         

                // determine wether a alternative track or quality was used and add this to the download messsage
                let downloadMessageAppend = '';

                // if alternative track was downloaded
                if (isAlternativeTrack && originalTrackInfos.SNG_TITLE_VERSION.trim().toLowerCase() !== trackInfos.SNG_TITLE_VERSION.trim().toLowerCase()) downloadMessageAppend = ' › Used "' + originalTrackInfos.ALB_ART_NAME + ' - ' + originalTrackInfos.SNG_TITLE_VERSION + '" as alternative';

                if (trackQuality !== selectedMusicQuality) { // if alternative quality was used
                    let selectedMusicQualityName = musicQualities[Object.keys(musicQualities).find(key => musicQualities[key] === selectedMusicQuality)].name;
                    let trackQualityName = musicQualities[Object.keys(musicQualities).find(key => musicQualities[key] === trackQuality)].name;

                    downloadMessageAppend += ' › Used "' + trackQualityName + '" because "' + selectedMusicQualityName + '" wasn\'t available';
                }

                //const successMessage = trackInfos.ALB_ART_NAME + ' - ' + trackInfos.SNG_TITLE_VERSION + downloadMessageAppend;

                const albumCoverSavePath = await this.downloadAlbumCover(trackInfos, saveFilePath, token_nr)

                if (!trackInfos.LYRICS || trackInfos.LYRICS_ID || 0 !== trackInfos.LYRICS_ID) trackInfos.LYRICS = await this.getTrackLyrics(trackInfos.SNG_ID, token_nr); // add better lyrics

                await this.addTagsAndStore(decryptedTrackBuffer, trackInfos, saveFilePath, albumCoverSavePath)

                this.removeDownloadedArt(albumCoverSavePath);

                resolve({msg: downloadMessageAppend, saveFilePath})
            } catch (err) {
                const nr = this.getActiveNR(track_id)
                const token_nr = this.getTokenNR(this.active[nr].arl)

                if (err instanceof XHRerror) {
                    if (err.message === "could not get TrackInfo") return reject(new downloadError("track not available"));
                }

                if (err instanceof downloadError) {
                    if (err.message === "track not available" && trackInfos.FALLBACK && trackInfos.FALLBACK.SNG_ID && trackInfos.SNG_ID !== trackInfos.FALLBACK.SNG_ID && !isAlternativeTrack) {
                        this.processDownload(trackInfos.FALLBACK.SNG_ID, trackInfos, albumInfos, true)
                    } else if (err.message === "track not available" && !isAlternativeTrack) {
                        this.getTrackAlternative(trackInfos, token_nr)
                        .then(alternativeTrackInfos => {
                            if (albumInfos.ALB_TITLE) albumInfos = {};

                            this.processDownload(alternativeTrackInfos.SNG_ID, trackInfos, albumInfos, true)
                            .then(msg => {
                                console.log("downloaded alternative track")
                                return resolve(msg);
                            })
                            .catch(() => { return reject(new downloadError("track not available")) })
                        })
                    } else {
                        return reject(new downloadError("track not available"));
                    }
                }

                return reject(err)
            }
        })
    }

    getTrackInfos(id, token_nr) {
        return new Promise((resolve, reject) => {
            axios.post(unofficialApiUrl+querystring.stringify(Object.assign({}, this.tokens[token_nr].unofficialApiQueries, {method: 'deezer.pageTrack', cid: this.getApiCid()})), {sng_id: id}, this.tokens[token_nr].config)
            .then(async response => {
                if (response && Object.keys(response.data.error).length === 0 && response.data.results && response.data.results.DATA) {
                    let trackInfos = response.data.results.DATA;

                    if (response.data.results.LYRICS) trackInfos.LYRICS = response.data.results.LYRICS;

                    trackInfos.SNG_TITLE_VERSION = trackInfos.SNG_TITLE;

                    if (trackInfos.VERSION) trackInfos.SNG_TITLE_VERSION = (trackInfos.SNG_TITLE + ' ' + trackInfos.VERSION).trim();

                    //this.active[this.getActiveNR(id)].originalTrackInfos = trackInfos;
                    return resolve(trackInfos)
                } else if (response.data.error.VALID_TOKEN_REQUIRED) { // add a function to retry here with new api_token, but for now just error
                    await this.initAPI(token_nr)

                    this.getTrackInfos(id, token_nr)
                    .then(trackInfos => { resolve(trackInfos) })
                    .catch(err => { reject(err) })
                } else {
                    return reject(new XHRerror("could not get TrackInfo", response.status))
                }
            })
            .catch(err => {
                return reject(new XHRerror("could not get TrackInfo", err))
            })
        })
    }

    /**
     * Get a downloadable track quality.
     *
     * FLAC > 320kbps > 128kbps
     * 320kbps > FLAC > 128kbps
     * 128kbps > 320kbps > FLAC
     *
     * @param {Object} trackInfos
     *
     * @returns {Object|Boolean}
     */
    getValidTrackQuality(trackInfos) {
        if (trackInfos.FILESIZE_MP3_MISC === 0) {
            return musicQualities.MP3_MISC;
        }

        if (selectedMusicQuality === musicQualities.FLAC) {
            if (trackInfos.FILESIZE_FLAC !== 0) return musicQualities.FLAC;
            if (trackInfos.FILESIZE_MP3_320 !== 0) return musicQualities.MP3_320;
            if (trackInfos.FILESIZE_MP3_128 === 0) return musicQualities.MP3_128;
            
            return false;
        }

        if (selectedMusicQuality === musicQualities.MP3_320) {
            if (trackInfos.FILESIZE_MP3_320 !== 0) return musicQualities.MP3_320;
            if (trackInfos.FILESIZE_FLAC !== 0 ) return musicQualities.FLAC;
            if (trackInfos.FILESIZE_MP3_128 !== 0) return musicQualities.MP3_128;
            
            return false;
        }

        if (selectedMusicQuality === musicQualities.MP3_128) {
            if (trackInfos.FILESIZE_MP3_128 !== 0) return musicQualities.MP3_128;
            if (trackInfos.FILESIZE_MP3_320 !== 0) return musicQualities.MP3_320;
            if (trackInfos.FILESIZE_FLAC !== 0) return musicQualities.FLAC;
            
            return false;
        }

        return false;
    }

    /**
     * Get infos of an album by id.
     *
     * @param {Number} id
     * @param {Number} token_nr
     */
    getAlbumInfos(id, token_nr) {
        return new Promise(resolve => {
            return axios.post(unofficialApiUrl+querystring.stringify(Object.assign({}, this.tokens[token_nr].unofficialApiQueries, {method: 'deezer.pageAlbum', cid: this.getApiCid()})), {alb_id: id, lang: 'us', tab: 0}, this.tokens[token_nr].config)
            .then(async response => {
                if (response && Object.keys(response.data.error).length === 0 && response.data.results && response.data.results.DATA && response.data.results.SONGS) {
                    let albumInfos = response.data.results.DATA;
                    albumInfos.SONGS = response.data.results.SONGS;

                    albumInfos.TYPE = 'album';
                    albumInfos.GENRES = [];

                    resolve(albumInfos);
                } else if (response.error.VALID_TOKEN_REQUIRED) {
                    await this.initAPI(token_nr)

                    this.getAlbumInfos(id, token_nr)
                    .then(albumInfos => { return resolve(albumInfos) })
                    .catch(err => { return reject(err) })
                } else { 
                    return reject({}) 
                }
            })
            .catch(() => { return reject({}) });
        });
    }

    // /**
    //  * Get infos of an album from the official api by id.
    //  *
    //  * @param {Number} id
    //  */
    // getAlbumInfosOfficialApi(id) {
    //     return new Promise((resolve, reject) => {
    //         return axios.get('https://api.deezer.com/album/' + id)
    //         .then((albumInfos) => {

    //             if (albumInfos && !albumInfos.data.error) {
    //                 resolve(albumInfos.data);
    //             } else {
    //                 reject({statusCode: 404});
    //             }
    //         }).catch(() => {
    //             reject({statusCode: 404});
    //         });
    //     });
    // }

    /**
     * Download the track, decrypt it and write it to a file.
     *
     * @param {Object} trackInfos
     * @param {Number} trackQualityId
     * @param {String} saveFilePath
     * @param {Number} token_nr
     * @param {Number} numberRetry
     */
    downloadTrack(trackInfos, trackQualityId, saveFilePath, token_nr, numberRetry = 0) {
        return new Promise((resolve, reject) => {
            const trackDownloadUrl = this.getTrackDownloadUrl(trackInfos, trackQualityId);

            // fix config
            delete this.tokens[token_nr].config.data
            let config = Object.assign({}, this.tokens[token_nr].config, {responseType: 'arraybuffer'})
            config.headers = Object.assign({}, config.headers, {'Content-Type': 'audio/mpeg'})

            axios.get(trackDownloadUrl, config)
            .then(response => {
                const decryptedTrackBuffer = encryptionService.decryptTrack(response.data, trackInfos);

                return resolve(decryptedTrackBuffer);
            })
            .catch(err => {
                if (403 === err.statusCode) {
                    let maxNumberRetry = 1;

                    if ((trackInfos.RIGHTS && 0 !== Object.keys(trackInfos.RIGHTS).length) || (trackInfos.AVAILABLE_COUNTRIES && trackInfos.AVAILABLE_COUNTRIES.STREAM_ADS && 0 < trackInfos.AVAILABLE_COUNTRIES.STREAM_ADS.length)) maxNumberRetry = 2;

                    if (maxNumberRetry >= numberRetry) {
                        numberRetry++;

                        setTimeout(() => {
                            this.downloadTrack(trackInfos, trackQualityId, saveFilePath, token_nr, numberRetry)
                            .then((decryptedTrackBuffer) => { return resolve(decryptedTrackBuffer) })
                            .catch(error => { return reject(error) })
                        }, 1000);
                    } else {
                        return reject(new downloadError("track not available"));
                    }
                } else {
                    return reject(new downloadError("track not available"));
                }
            });
        });
    }

    /**
     * Get lyrics of a track by id.
     *
     * @param {Number} id
     * @param {Number} token_nr
     */
    getTrackLyrics(id, token_nr) {
        return new Promise(resolve => {

            return axios.post(unofficialApiUrl+querystring.stringify(Object.assign({}, this.tokens[token_nr].unofficialApiQueries, {method: 'song.getLyrics', cid: this.getApiCid()})), {sng_id: id}, this.tokens[token_nr].config)
            .then(async response => {
                if (response && 0 === Object.keys(response.data.error).length && response.data.results && response.data.results.LYRICS_ID) {
                    let trackLyrics = response.data.results;

                    resolve(trackLyrics);
                } else if (response.data.error.VALID_TOKEN_REQUIRED) {
                    await this.initAPI(token_nr);

                    this.getTrackLyrics(id, token_nr)
                    .then(trackLyrics => { return resolve(trackLyrics); })
                    .catch(err => { return resolve(err) });
                } else {
                    return resolve(null);
                }
            }).catch(() => {
                return resolve(null);
            });
        });
    }

    /**
     * Download the album cover of a track.
     *
     * @param {Object} trackInfos
     * @param {String} saveFilePath
     * @param {Number} token_nr 
     * @param {Number} numberRetry
     */
    downloadAlbumCover(trackInfos, saveFilePath, token_nr, numberRetry = 0) {
        return new Promise(resolve => {
            const albumCoverSavePath = saveFilePath.slice(0,-3) + 'jpg';
            // check to make sure there is a cover for this album
            if (!trackInfos.ALB_PICTURE) {
                return resolve(null);
            } else if (!fs.existsSync(albumCoverSavePath)) {
                const albumCoverUrl = 'https://e-cdns-images.dzcdn.net/images/cover/' + trackInfos.ALB_PICTURE + '/1400x1400-000000-94-0-0.jpg';

                // fix config
                delete this.tokens[token_nr].config.data
                let config = Object.assign({}, this.tokens[token_nr].config, {responseType: 'arraybuffer'})
                config.headers = Object.assign({}, config.headers, {'Content-Type': 'image/jpeg'})

                return axios.get(albumCoverUrl, config)
                .then(response => {
                    this.ensureDir(albumCoverSavePath);
                    fs.writeFile(albumCoverSavePath, response.data, err => {
                        if (err) return resolve(null);
                        return resolve(albumCoverSavePath);
                    });
                })
                .catch(err => {
                    if (403 === err.statusCode) {
                        if (numberRetry > 3) {
                            numberRetry++;

                            setTimeout(() => {
                                this.downloadAlbumCover(trackInfos, saveFilePath, token_nr, numberRetry)
                                .then(albumCoverSavePath => { return resolve(albumCoverSavePath) })
                                .catch(() => { return resolve(null) })
                            }, 500);
                        } else {
                            return resolve(null);
                        }
                    } else {
                        return resolve(null);
                    }
                });
            } else {
                resolve(albumCoverSavePath);
            }
        });
    }

    addTagsAndStore(decryptedTrackBuffer, trackInfos, saveFilePath, albumCoverSavePath = null, numberRetry = 0) {
        return new Promise((resolve, reject) => {
            try {
                let trackMetadata = {
                    title: '',
                    album: '',
                    releaseType: '',
                    genre: '',
                    artists: [],
                    albumArtist: '',
                    trackNumber: '',
                    trackNumberCombined: '',
                    partOfSet: '',
                    partOfSetCombined: '',
                    label: '',
                    copyright: '',
                    composer: [],
                    publisher: [],
                    producer: [],
                    engineer: [],
                    writer: [],
                    author: [],
                    mixer: [],
                    ISRC: '',
                    duration: '',
                    bpm: '',
                    upc: '',
                    explicit: '',
                    tracktotal: '',
                    disctotal: '',
                    compilation: '',
                    unsynchronisedLyrics: '',
                    synchronisedLyrics: '',
                    media: 'Digital Media',
                };

                if (trackInfos.SNG_TITLE_VERSION) trackMetadata.title = trackInfos.SNG_TITLE_VERSION;
                if (trackInfos.ALB_TITLE) trackMetadata.album = trackInfos.ALB_TITLE;
                if (trackInfos.ALB_ART_NAME) trackMetadata.albumArtist = trackInfos.ALB_ART_NAME;
                if (trackInfos.DURATION) trackMetadata.duration = trackInfos.DURATION;
                if (trackInfos.ALB_UPC) trackMetadata.upc = trackInfos.ALB_UPC;

                if (trackInfos.ALB_RELEASE_TYPE) {
                    let releaseType = trackInfos.ALB_RELEASE_TYPE;

                    'ep' === releaseType ? releaseType = 'EP' : releaseType = this.capitalizeFirstLetter(releaseType);

                    trackMetadata.releaseType = releaseType;
                }

                if (trackInfos.ALB_GENRES && trackInfos.ALB_GENRES[0]) trackMetadata.genre = trackInfos.ALB_GENRES[0];

                if (trackInfos.TRACK_NUMBER) {
                    trackMetadata.trackNumber = trackInfos.TRACK_NUMBER;
                    trackMetadata.trackNumberCombined = trackInfos.TRACK_NUMBER;
                }

                if (trackInfos.ALB_NUM_TRACKS) {
                    trackMetadata.tracktotal = trackInfos.ALB_NUM_TRACKS;
                    trackMetadata.trackNumberCombined += '/' + trackInfos.ALB_NUM_TRACKS;
                }

                if (trackInfos.DISK_NUMBER) {
                    trackMetadata.partOfSet = trackInfos.DISK_NUMBER;
                    trackMetadata.partOfSetCombined = trackInfos.DISK_NUMBER;
                }

                if (trackInfos.ALB_NUM_DISCS) {
                    trackMetadata.disctotal = trackInfos.ALB_NUM_DISCS;
                    trackMetadata.partOfSetCombined += '/' + trackInfos.ALB_NUM_DISCS;
                }

                if (trackInfos.ALB_RELEASE_DATE || trackInfos.PHYSICAL_RELEASE_DATE) {
                    let releaseDate = trackInfos.ALB_RELEASE_DATE;

                    if (!trackInfos.ALB_RELEASE_DATE) releaseDate = trackInfos.PHYSICAL_RELEASE_DATE;

                    trackMetadata.releaseYear = releaseDate.slice(0, 4);
                    trackMetadata.releaseDate = releaseDate.slice(0, 10);
                }

                if (trackInfos.ALB_LABEL) trackMetadata.label = trackInfos.ALB_LABEL;
                if (trackInfos.COPYRIGHT) trackMetadata.copyright = trackInfos.COPYRIGHT;
                if (trackInfos.ISRC) trackMetadata.ISRC = trackInfos.ISRC;
                if (trackInfos.BPM) trackMetadata.bpm = trackInfos.BPM;
                if (trackInfos.EXPLICIT_LYRICS) trackMetadata.explicit = trackInfos.EXPLICIT_LYRICS;

                if (trackInfos.ARTISTS) {
                    let trackArtists = [];

                    trackInfos.ARTISTS.forEach((trackArtist) => {
                        if (trackArtist.ART_NAME) {
                            trackArtist = trackArtist.ART_NAME.split(new RegExp(' featuring | feat. | Ft. | ft. | vs | vs. | x | - |, ', 'g'));
                            trackArtist = trackArtist.map(Function.prototype.call, String.prototype.trim);

                            trackArtists = trackArtists.concat(trackArtist);
                        }
                    });

                    trackArtists = [...new Set(trackArtists)];
                    trackMetadata.artists = trackArtists;
                }

                if (trackInfos.SNG_CONTRIBUTORS) {
                    if (trackInfos.SNG_CONTRIBUTORS.composer) trackMetadata.composer = trackInfos.SNG_CONTRIBUTORS.composer;
                    if (trackInfos.SNG_CONTRIBUTORS.musicpublisher) trackMetadata.publisher = trackInfos.SNG_CONTRIBUTORS.musicpublisher;
                    if (trackInfos.SNG_CONTRIBUTORS.producer) trackMetadata.producer = trackInfos.SNG_CONTRIBUTORS.producer;
                    if (trackInfos.SNG_CONTRIBUTORS.engineer) trackMetadata.engineer = trackInfos.SNG_CONTRIBUTORS.engineer;
                    if (trackInfos.SNG_CONTRIBUTORS.writer) trackMetadata.writer = trackInfos.SNG_CONTRIBUTORS.writer;
                    if (trackInfos.SNG_CONTRIBUTORS.author) trackMetadata.author = trackInfos.SNG_CONTRIBUTORS.author;
                    if (trackInfos.SNG_CONTRIBUTORS.mixer) trackMetadata.mixer = trackInfos.SNG_CONTRIBUTORS.mixer;
                }

                'Various Artists' === trackMetadata.performerInfo ? trackMetadata.compilation = 1 : trackMetadata.compilation = 0;

                //lyrics are allowed to be added to the metadata
                if (trackInfos.LYRICS) {
                    if (trackInfos.LYRICS.LYRICS_TEXT) trackMetadata.unsynchronisedLyrics = trackInfos.LYRICS.LYRICS_TEXT;

                    if (trackInfos.LYRICS.LYRICS_SYNC_JSON) {
                        const syncedLyrics = trackInfos.LYRICS.LYRICS_SYNC_JSON;

                        for (let i = 0; i < syncedLyrics.length; i++) {
                            if (syncedLyrics[i].lrc_timestamp) {
                                trackMetadata.synchronisedLyrics += syncedLyrics[i].lrc_timestamp + syncedLyrics[i].line + '\r\n';
                            } else if (i + 1 < syncedLyrics.length) {
                                trackMetadata.synchronisedLyrics += syncedLyrics[i + 1].lrc_timestamp + syncedLyrics[i].line + '\r\n';
                            }
                        }
                    }
                }

                let saveFilePathExtension = nodePath.extname(saveFilePath);

                if ('.mp3' === saveFilePathExtension) {
                    //screw those lyrics files
                    /*if ('' !== trackMetadata.synchronisedLyrics.trim()) {
                        const lyricsFile = saveFilePath.slice(0, -4) + '.lrc';

                        that.ensureDir(lyricsFile);
                        fs.writeFileSync(lyricsFile, trackMetadata.synchronisedLyrics);
                    }*/

                    const writer = new id3Writer(decryptedTrackBuffer);
                    let coverBuffer;

                    if (albumCoverSavePath && fs.existsSync(albumCoverSavePath)) coverBuffer = fs.readFileSync(albumCoverSavePath)

                    writer
                        .setFrame('TIT2', trackMetadata.title)
                        .setFrame('TALB', trackMetadata.album)
                        .setFrame('TCON', [trackMetadata.genre])
                        .setFrame('TPE2', trackMetadata.albumArtist)
                        .setFrame('TPE1', [trackMetadata.artists.join(', ')])
                        .setFrame('TRCK', trackMetadata.trackNumberCombined)
                        .setFrame('TPOS', trackMetadata.partOfSetCombined)
                        .setFrame('TCOP', trackMetadata.copyright)
                        .setFrame('TPUB', trackMetadata.publisher.join('/'))
                        .setFrame('TMED', trackMetadata.media)
                        .setFrame('TCOM', trackMetadata.composer)
                        .setFrame('TXXX', {
                            description: 'Artists',
                            value: trackMetadata.artists.join('/')
                        })
                        .setFrame('TXXX', {
                            description: 'RELEASETYPE',
                            value: trackMetadata.releaseType
                        })
                        .setFrame('TSRC', trackMetadata.ISRC)
                        .setFrame('TXXX', {
                            description: 'BARCODE',
                            value: trackMetadata.upc
                        })
                        .setFrame('TXXX', {
                            description: 'LABEL',
                            value: trackMetadata.label
                        })
                        .setFrame('TXXX', {
                            description: 'LYRICIST',
                            value: trackMetadata.writer.join('/')
                        })
                        .setFrame('TXXX', {
                            description: 'MIXARTIST',
                            value: trackMetadata.mixer.join('/')
                        })
                        .setFrame('TXXX', {
                            description: 'INVOLVEDPEOPLE',
                            value: trackMetadata.producer.concat(trackMetadata.engineer).join('/')
                        })
                        .setFrame('TXXX', {
                            description: 'COMPILATION',
                            value: trackMetadata.compilation
                        })
                        .setFrame('TXXX', {
                            description: 'EXPLICIT',
                            value: trackMetadata.explicit
                        })
                        .setFrame('TXXX', {
                            description: 'SOURCE',
                            value: 'Deezer'
                        })
                        .setFrame('TXXX', {
                            description: 'SOURCEID',
                            value: trackInfos.SNG_ID
                        });

                    if ('' !== trackMetadata.unsynchronisedLyrics) {
                        writer.setFrame('USLT', {
                            description: '',
                            lyrics: trackMetadata.unsynchronisedLyrics
                        });
                    }

                    if (coverBuffer) {
                        writer.setFrame('APIC', {
                            type: 3,
                            data: coverBuffer,
                            description: ''
                        });
                    }

                    if (0 < parseInt(trackMetadata.releaseYear)) writer.setFrame('TYER', trackMetadata.releaseYear);
                    if (0 < parseInt(trackMetadata.releaseDate)) writer.setFrame('TDAT', trackMetadata.releaseDate);
                    if (0 < parseInt(trackMetadata.bpm)) writer.setFrame('TBPM', trackMetadata.bpm);

                    writer.addTag();

                    const taggedTrackBuffer = Buffer.from(writer.arrayBuffer);

                    this.ensureDir(saveFilePath);
                    fs.writeFileSync(saveFilePath, taggedTrackBuffer);

                    return resolve();
                } else if ('.flac' === saveFilePathExtension) {
                    // I dont want seperate lyrics files
                    /*if ('' !== trackMetadata.synchronisedLyrics.trim()) {
                        const lyricsFile = saveFilePath.slice(0, -5) + '.lrc';

                        that.ensureDir(lyricsFile);
                        fs.writeFileSync(lyricsFile, trackMetadata.synchronisedLyrics);
                    }*/

                    let flacComments = [
                        'SOURCE=Deezer',
                        'SOURCEID=' + trackInfos.SNG_ID
                    ];

                    if ('' !== trackMetadata.title) flacComments.push('TITLE=' + trackMetadata.title);
                    if ('' !== trackMetadata.album) flacComments.push('ALBUM=' + trackMetadata.album);
                    if ('' !== trackMetadata.genre) flacComments.push('GENRE=' + trackMetadata.genre);
                    if ('' !== trackMetadata.albumArtist) flacComments.push('ALBUMARTIST=' + trackMetadata.albumArtist);
                    if (0 < trackMetadata.artists.length) flacComments.push('ARTIST=' + trackMetadata.artists.join(', '));
                    if ('' !== trackMetadata.trackNumber) flacComments.push('TRACKNUMBER=' + trackMetadata.trackNumber);

                    if ('' !== trackMetadata.tracktotal) {
                        flacComments.push('TRACKTOTAL=' + trackMetadata.tracktotal);
                        flacComments.push('TOTALTRACKS=' + trackMetadata.tracktotal);
                    }

                    if ('' !== trackMetadata.partOfSet) flacComments.push('DISCNUMBER=' + trackMetadata.partOfSet);

                    if ('' !== trackMetadata.disctotal) {
                        flacComments.push('DISCTOTAL=' + trackMetadata.disctotal);
                        flacComments.push('TOTALDISCS=' + trackMetadata.disctotal);
                    }

                    if ('' !== trackMetadata.label) flacComments.push('LABEL=' + trackMetadata.label);
                    if ('' !== trackMetadata.copyright) flacComments.push('COPYRIGHT=' + trackMetadata.copyright);
                    if ('' !== trackMetadata.duration) flacComments.push('LENGTH=' + trackMetadata.duration)
                    if ('' !== trackMetadata.ISRC) flacComments.push('ISRC=' + trackMetadata.ISRC);
                    if ('' !== trackMetadata.upc) flacComments.push('BARCODE=' + trackMetadata.upc);
                    if ('' !== trackMetadata.media) flacComments.push('MEDIA=' + trackMetadata.media);
                    if ('' !== trackMetadata.compilation) flacComments.push('COMPILATION=' + trackMetadata.compilation);
                    if ('' !== trackMetadata.explicit) flacComments.push('EXPLICIT=' + trackMetadata.explicit);

                    if (trackMetadata.releaseType) flacComments.push('RELEASETYPE=' + trackMetadata.releaseType);

                    trackMetadata.artists.forEach((artist) => {
                        flacComments.push('ARTISTS=' + artist);
                    });

                    trackMetadata.composer.forEach((composer) => {
                        flacComments.push('COMPOSER=' + composer);
                    });

                    trackMetadata.publisher.forEach((publisher) => {
                        flacComments.push('ORGANIZATION=' + publisher);
                    });

                    trackMetadata.producer.forEach((producer) => {
                        flacComments.push('PRODUCER=' + producer);
                    });

                    trackMetadata.engineer.forEach((engineer) => {
                        flacComments.push('ENGINEER=' + engineer);
                    });

                    trackMetadata.writer.forEach((writer) => {
                        flacComments.push('WRITER=' + writer);
                    });

                    trackMetadata.author.forEach((author) => {
                        flacComments.push('AUTHOR=' + author);
                    });

                    trackMetadata.mixer.forEach((mixer) => {
                        flacComments.push('MIXER=' + mixer);
                    });

                    if (trackMetadata.unsynchronisedLyrics) flacComments.push('LYRICS=' + trackMetadata.unsynchronisedLyrics);

                    if (0 < parseInt(trackMetadata.releaseYear)) flacComments.push('YEAR=' + trackMetadata.releaseYear);
                    if (0 < parseInt(trackMetadata.releaseDate)) flacComments.push('DATE=' + trackMetadata.releaseDate);
                    if (0 < parseInt(trackMetadata.bpm)) flacComments.push('BPM=' + trackMetadata.bpm);

                    const reader = new stream.PassThrough();
                    reader.end(decryptedTrackBuffer);

                    this.ensureDir(saveFilePath);

                    const writer = fs.createWriteStream(saveFilePath);
                    let processor = new flacMetadata.Processor({parseMetaDataBlocks: true});
                    let vendor = 'reference libFLAC 1.2.1 20070917';
                    let coverBuffer;

                    if (albumCoverSavePath && fs.existsSync(albumCoverSavePath)) coverBuffer = fs.readFileSync(albumCoverSavePath);

                    let mdbVorbisComment;
                    let mdbVorbisPicture;

                    processor.on('preprocess', (mdb) => {
                        // Remove existing VORBIS_COMMENT and PICTURE blocks, if any.
                        if (flacMetadata.Processor.MDB_TYPE_VORBIS_COMMENT === mdb.type) {
                            mdb.remove();
                        } else if (coverBuffer && flacMetadata.Processor.MDB_TYPE_PICTURE === mdb.type) {
                            mdb.remove();
                        }

                        if (mdb.isLast) {
                            mdbVorbisComment = flacMetadata.data.MetaDataBlockVorbisComment.create(!coverBuffer, vendor, flacComments);

                            if (coverBuffer) mdbVorbisPicture = flacMetadata.data.MetaDataBlockPicture.create(true, 3, 'image/jpeg', '', 1400, 1400, 24, 0, coverBuffer);

                            mdb.isLast = false;
                        }
                    });

                    processor.on('postprocess', (mdb) => {
                        if (flacMetadata.Processor.MDB_TYPE_VORBIS_COMMENT === mdb.type && null !== mdb.vendor) vendor = mdb.vendor;
                        if (mdbVorbisComment) processor.push(mdbVorbisComment.publish());
                        if (mdbVorbisPicture) processor.push(mdbVorbisPicture.publish());
                    });

                    reader.on('end', () => { return resolve() });

                    reader.pipe(processor).pipe(writer);
                }
            } catch (err) {
                if (numberRetry < 3) {
                    numberRetry++;

                    setTimeout(() => {
                        this.addTagsAndStore(decryptedTrackBuffer, trackInfos, saveFilePath, albumCoverSavePath, numberRetry)
                        .then(() => { resolve() })
                        .catch(() => { reject() })
                    }, 500);
                } else {
                    this.ensureDir(saveFilePath);
                    fs.writeFileSync(saveFilePath, decryptedTrackBuffer);

                    return reject();
                }
            }
        })
    }

    /**
     * Get alternative track for a song by its track infos.
     *
     * @param {Object} trackInfos
     * @param {Number} token_nr token number for the arl/user to use
     */
    getTrackAlternative(trackInfos, token_nr) {
        return new Promise((resolve, reject) => {
            return axios.post(unofficialApiUrl+querystring.stringify(Object.assign({}, this.tokens[token_nr].unofficialApiQueries, { method: 'search.music', cid: this.getApiCid() })), {QUERY: 'artist:\'' + trackInfos.ART_NAME + '\' track:\'' + trackInfos.SNG_TITLE + '\'', OUTPUT: 'TRACK', NB: 50, FILTER: 0}, this.tokens[token_nr].config)
            .then(async response => {
                if (response && 0 === Object.keys(response.data.error).length && response.data.results && response.data.results.data && 0 > response.data.results.data.length) {
                    const foundTracks = response.data.results.data;
                    let matchingTracks = [];
                    if (foundTracks.length > 0) {
                        foundTracks.forEach(foundTrack => { if (trackInfos.MD5_ORIGIN === foundTrack.MD5_ORIGIN && trackInfos.DURATION - 5 <= foundTrack.DURATION && trackInfos.DURATION + 10 >= foundTrack.DURATION) matchingTracks.push(foundTrack) });

                        if (1 === matchingTracks.length) {
                            return resolve(matchingTracks[0]);
                        } else {
                            let foundAlternativeTrack = false;

                            if (0 === matchingTracks.length) {
                                foundTracks.forEach((foundTrack) => { if (trackInfos.MD5_ORIGIN === foundTrack.MD5_ORIGIN) matchingTracks.push(foundTrack) });
                            }

                            matchingTracks.forEach((foundTrack) => {
                                foundTrack.SNG_TITLE_VERSION = foundTrack.SNG_TITLE;

                                if (foundTrack.VERSION) {
                                    foundTrack.SNG_TITLE_VERSION = (foundTrack.SNG_TITLE + ' ' + foundTrack.VERSION).trim();
                                }

                                if (this.removeWhitespacesAndSpecialChars(trackInfos.SNG_TITLE_VERSION).toLowerCase() === this.removeWhitespacesAndSpecialChars(foundTrack.SNG_TITLE_VERSION).toLowerCase()) {
                                    foundAlternativeTrack = true;

                                    return resolve(foundTrack);
                                }
                            });

                            if (!foundAlternativeTrack) return reject("did not find alternative track");
                        }
                    } else {
                        return reject("did not find alternative track");
                    }
                } else if (response.data.error.VALID_TOKEN_REQUIRED) {
                    await this.initAPI(token_nr);

                    this.getTrackAlternative(trackInfos)
                    .then(alternativeTrackInfos => { return resolve(alternativeTrackInfos) })
                    .catch(err => { return reject(err) });
                } else {
                    return reject("did not find alternative track");
                }
            }).catch(() => {
                return reject("did not receive response");
            });
        });
    }
}

let smloadr = new smloadrClass;
module.exports = smloadr; // default export
