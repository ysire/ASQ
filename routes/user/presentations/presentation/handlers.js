var asyncblock = require('asyncblock')
  , cheerio    = require('cheerio')
  , pfs        = require('promised-io/fs')
  , lib        = require('../../../../lib')
  , appLogger  = lib.logger.appLogger
  , presUtils  = lib.utils.presentation
  , config     = require('../../../../config')

function editPresentation(req, res) {
  var Slideshow = db.model('Slideshow', schemas.slideshowSchema);
  var questionDB = db.model('Question', schemas.questionSchema);

  Slideshow.findById(req.params.presentationId, function(err, slideshow) {
    if (err) {
      appLogger.error(err.toString());
    } else {
      /* Load presentation html file */
      pfs.readFile(slideshow.presenterFile, 'utf-8').then(function(data) {

        //Array with one field per slide. Each field has questions and stats
        var slides = [];
        $ = cheerio.load(data);
        $('.step').each(function(slide) {
          //Get questions on this slide. Get their text and push it into an array
          var questionsOnSlide = new Array();
          $(this).find('.assessment').each(function(el) {
            var text = $(this).find('.stem').first().text();
            if (text == undefined || text.length == 0) {
              text = 'Missing question text';
            }
            questionsOnSlide.push(text);
          });

          //Get stats on this slide. Get their text and push it into an array
          var statsOnSlide = new Array();
          $(this).find('.stats').each(function(el) {
            var text = $(this).find('.stem').first().text();
            if (text == undefined || text.length == 0) {
              text = 'Missing question text';
            }
            statsOnSlide.push(text);
          });

          //Push questions and stats on this slide into array
          slides.push({
            questions : questionsOnSlide,
            stats     : statsOnSlide
          });
        });

        res.render('edit', {
          title     : slideshow.title,
          slides    : slides,
          slideshow : slideshow,
        });
      }, function(error){
        //TODO How about handling the error?
        appLogger.error('This is an error left unhandeled...');
        appLogger.error(error.toStirng());
      });
    }
  });
}

function livePresentation(req, res) {
  appLogger.debug(req.query.role);
  appLogger.debug(require('util').inspect(req.whitelistEntry));
  var role = req.query.role || 'viewer'; //Check user is allowed to have this role
  if (req.whitelistEntry !== undefined) {
    role = req.whitelistEntry.validateRole(role); //Demotion of role if too elevated for the user
  } else {
    appLogger.debug('Public session');
    role = 'viewer' //Public session and not whitelisted only allows viewers.
  }
  var view = req.query.view || 'presentation';
  var presentation = req.liveSession.slides;
  //TMP until roles are defined more precisly 
  appLogger.debug('Select template for ' + role + ' ' + view);
  var renderOpts = (function getTemplate(role, view, presentation) {
      if (view === 'ctrl' && role !== 'viewer') {
        return {
          template: 'presenterControl',
          mode: 'controll',
        };
      } else if (role === 'presenter' || role === 'assistant') {
        return {
          template: presentation.presenterFile,
          mode: 'presenter',
        };
      }
      return {
          template: presentation.viewerFile,
          mode: 'viewer',
        };
  })(role, view, presentation);
  appLogger.debug('Selected template: ' + renderOpts.template);

  var presentationViewUrl = ASQ.rootUrl + '/' + req.user.name + '/presentations/' 
                            + presentation._id + '/live/' + req.liveSession.id 
                            + '/?role=' + role+ '&view=presentation';
  console.log(presentationViewUrl)

  var presenterLiveUrl = ASQ.rootUrl + '/' + req.user.name + '/live/';

  res.render(renderOpts.template, {
    title : presentation.title,
    host  : process.env.HOST,
    port  : process.env.PORT,
    mode  : renderOpts.mode,
    id    : req.liveSession.id,
    date  : req.liveSession.startDate,
    presentationViewUrl: presentationViewUrl,
    presenterLiveUrl : presenterLiveUrl
  });
}

function livePresentationFiles(req, res) {
  var presentation = req.liveSession.slides;
  var file = req.params[0];
  if (presentation && file === presentation.originalFile) {
    res.redirect(301, ['/', req.user.name, '/presentations/',
        req.params.presentationId, '/live/', req.params.liveId,
        '/?view=presentation'].join(''));
  } else if(presentation) {
    res.sendfile(presentation.path + file);
  } else {
    res.send(404, 'Presentation not found, unable to serve attached file.');
  }
}


function startPresentation(req, res) {
  appLogger.debug('New session from ' + req.user.name);
  var slidesId = req.params.presentationId;

  asyncblock(function(flow) {

    //Error Handling
    flow.errorCallback = function errorCallback(err) {
      appLogger.error('Presentation Start\n' + err);
      return res.redirect(500, ['/', req.user.name,
          '/?alert=Something went wrong. The Great ASQ Server said: ',
          err.toString(), '&type=error'].join(''));
    }

    //Find slideshow
    var Slideshow = db.model('Slideshow', schemas.slideshowSchema);
    Slideshow.findOne({ 
      _id   : slidesId,
      owner : req.user._id }, flow.set('slideshow'));

    //Instantiate a new session
    var Session = db.model('Session', schemas.sessionSchema);
    var newSession = new Session();
    newSession.presenter = req.user._id;
    newSession.slides = flow.get('slideshow')._id;
    newSession.authLevel = ( Session.schema.path('authLevel').enumValues
      .indexOf(req.query.al) > -1 ) ? req.query.al : 'public';
    
    //Save the new session
    newSession.save(flow.add());

    //Generate the white list for the level
    presUtils.generateWhitelist[newSession.authLevel]
      (newSession._id, newSession.presenter, flow.add());

    //Update the suer's current session
    var User = db.model('User', schemas.userSchema);
    User.findByIdAndUpdate(req.user._id, {
      current : newSession._id }, flow.add());

    //Update slideshow's last presnetation to now
    flow.get('slideshow').lastSession = new Date();
    flow.get('slideshow').save(flow.add());

    //Wait to finish and redirect
    flow.wait();
    appLogger.info('Starting new ' + newSession.authLevel + ' session');
    res.location(['/', req.user.name, '/presentations/', newSession.slides,
      '/live/', newSession._id, '/?role=presenter&view=ctrl'].join(''));
    res.send(201);
  });
}

module.exports = {
  editPresentation      : editPresentation,
  livePresentation      : livePresentation,
  livePresentationFiles : livePresentationFiles,
  startPresentation     : startPresentation
}