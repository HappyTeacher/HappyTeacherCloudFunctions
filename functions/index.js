const functions = require('firebase-functions');

// The Firebase Admin SDK to access the Firebase Realtime Database. 
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);

exports.addLessonHeader = functions.database.ref('{languageCode}/subtopic_lessons/{subtopicId}/{lessonId}')
    .onWrite(event => {
		// Grab the current value of what was written to the Realtime Database.
		const lesson = event.data.val();
		const lessonKey = event.data.key;
		
		const authorEmail = lesson["authorEmail"];
		const authorInstitution = lesson["authorInstitution"];
		const authorLocation = lesson["authorLocation"];
		const authorName = lesson["authorName"];
		const dateEdited = lesson["dateEdited"];
		const name = lesson["name"];

		console.log('Creating lesson header for subtopic', name, "from email ID", authorEmail);

		const isFeatured = lesson["isFeatured"];
		const topicId = lesson["topic"];

		const lessonHeader = {
			"authorEmail": authorEmail,
			"authorInstitution": authorInstitution,
			"authorLocation": authorLocation,
			"authorName": authorName,
			"dateEdited": dateEdited,
			"name": name,
			"lesson": lessonKey,
			"isFeatured": isFeatured
		}

		const headerPath = event.params.languageCode + "/subtopic_lesson_headers/" + topicId + "/" + event.params.subtopicId + "/" + lessonKey;
		const headerRef = admin.database().ref(headerPath);
		return headerRef.set(lessonHeader);
    });

exports.updateFeaturedLessonHeader = functions.database.ref('{languageCode}/subtopic_lesson_headers/{topicId}/{subtopicId}/{lessonKey}')
    .onWrite(event => {
		// Grab the current value of what was written to the Realtime Database.
		const lessonHeader = event.data.val();
		const headerKey = event.data.key;

		if (lessonHeader["isFeatured"]) {
			const featuredHeaderPath = event.params.languageCode + "/featured_subtopic_lesson_headers/" + event.params.topicId + "/" + event.params.subtopicId;
			const featuredHeaderRef = admin.database().ref(featuredHeaderPath);
			return featuredHeaderRef.set(lessonHeader);
		} else {
			return null;
		}
    });
