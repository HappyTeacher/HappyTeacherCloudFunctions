const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);

exports.addLessonHeader = functions.database.ref('{languageCode}/subtopic_lessons/{topicId}/{subtopicId}/{lessonId}')
    .onWrite(event => {
		// Grab the current value of what was written to the Realtime Database.
		const lesson = event.data.val();
		const lessonKey = event.data.key;

		const headerPath = event.params.languageCode + "/subtopic_lesson_headers/" + event.params.topicId + "/" + event.params.subtopicId + "/" + event.params.lessonId;
		const headerRef = admin.database().ref(headerPath);

		if (!lesson) {
			return headerRef.remove();
		}
		
		const authorEmail = lesson["authorEmail"];
		const authorInstitution = lesson["authorInstitution"];
		const authorLocation = lesson["authorLocation"];
		const authorName = lesson["authorName"];
		const dateEdited = lesson["dateEdited"];
		const name = lesson["name"];
		const subjectName = lesson["subjectName"];

		console.log('Creating lesson header for subtopic', name, "from email ID", authorEmail);

		const isFeatured = lesson["isFeatured"];

		const subtopicSubmissionPath = event.params.languageCode + "/subtopic_lessons/" + event.params.topicId + "/" + event.params.subtopicId;
		const submissionRef = admin.database().ref(subtopicSubmissionPath)

		const lessonHeader = {
			"authorEmail": authorEmail,
			"authorInstitution": authorInstitution,
			"authorLocation": authorLocation,
			"authorName": authorName,
			"dateEdited": dateEdited,
			"name": name,
			"lesson": lessonKey,
			"isFeatured": isFeatured,
			"subtopic": event.params.subtopicId,
			"topic": event.params.topicId,
			"subjectName": subjectName
		}

		return headerRef.set(lessonHeader);
    });

exports.updateFeaturedLessonHeader = functions.database.ref('{languageCode}/subtopic_lesson_headers/{topicId}/{subtopicId}/{lessonKey}')
    .onWrite(event => {
		// Grab the current value of what was written to the Realtime Database.
		const lessonHeader = event.data.val();
		const headerKey = event.data.key;

		const featuredHeaderPath = event.params.languageCode + "/featured_subtopic_lesson_headers/" + event.params.topicId + "/" + event.params.subtopicId;
		const featuredHeaderRef = admin.database().ref(featuredHeaderPath);

		if (!lessonHeader) {
			return featuredHeaderRef.remove();
		}

		const subtopicSubmissionPath = event.params.languageCode + "/subtopic_lessons/" + event.params.topicId + "/" + event.params.subtopicId;
		const subtopicSubmissionRef = admin.database().ref(subtopicSubmissionPath);

		return subtopicSubmissionRef.once('value').then(function(dataSnapshot) {
			const submissionCount = dataSnapshot.numChildren();
			lessonHeader["subtopicSubmissionCount"] = submissionCount;
			
			if (lessonHeader["isFeatured"]) {
				return featuredHeaderRef.set(lessonHeader);
			} else {
				return featuredHeaderRef.once('value').then(function(dataSnapshot) {
					if (dataSnapshot.hasChildren()) {
						// ==> this featured header has items in it ==> it exists!
						const subtopicSubmissionRef = featuredHeaderRef.child("subtopicSubmissionCount");
						return subtopicSubmissionRef.set(submissionCount);
					} else {
						// There is no featured header to update.
						return null;
					}
				});
			}
		});
    });

exports.countFeaturedSubtopicsForTopic = functions.database.ref('{languageCode}/featured_subtopic_lesson_headers/{topicId}/{subtopicId}/')
	.onWrite(event => {
		const parentPath = event.params.languageCode + "/featured_subtopic_lesson_headers/" + event.params.topicId;
		const parentRef = admin.database().ref(parentPath);

		return parentRef.once('value').then(function(dataSnapshot) {
    		const subtopicCount = dataSnapshot.numChildren()
    		const subtopicCountPath = event.params.languageCode + "/topics/" + event.params.topicId + "/featuredSubtopicCount";
			const subtopicCountRef = admin.database().ref(subtopicCountPath);

			return subtopicCountRef.set(subtopicCount);
		});
	});

