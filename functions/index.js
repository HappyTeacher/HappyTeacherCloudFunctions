const functions = require('firebase-functions');
const admin = require('firebase-admin');
const gcs = require('@google-cloud/storage')();
admin.initializeApp(functions.config().firebase);

exports.countSubtopicSubmissions = functions.firestore.document('localized/{languageCode}/lessons/{lessonId}')
	.onWrite(event => {
        var subtopic = null;

        // Begin by setting subtopic to be the old subtopic, if possible:
	    if (event.data.previous && event.data.previous.data()["subtopic"]) {
	        subtopic = event.data.previous.data()["subtopic"]
        }

        // If there's a new subtopic (and the data hasn't been deleted), use that:
        if (event.data.exists && event.data.data()["subtopic"]) {
            subtopic = event.data.data()["subtopic"];
        }

        // If neither the old nor new data has a subtopic, return null.
        if (!subtopic) {
	        return null;
        }

	    const lessonCollectionRef = event.data.ref.parent;
        const lessonsForSubtopicQuery = lessonCollectionRef.where("subtopic", "==", subtopic);

        return lessonsForSubtopicQuery.get().then(function(querySnapshot) {
            const count = querySnapshot.size;

            const featuredLessonsForSubtopicQuery = lessonsForSubtopicQuery.where("isFeatured", "==", true);

            const writePromises = [];
            featuredLessonsForSubtopicQuery.get().then(function(querySnapshot) {
                querySnapshot.forEach(function(doc) {
                    var writePromise = doc.ref.update({subtopicSubmissionCount : count});
                    writePromises.push(writePromise);
                });

                // Write count to all featured lessons (there should only be one)
                return Promise.all(writePromises);
            });
        });
	});

exports.addAttachmentMetadataToCard = functions.firestore.document('localized/{languageCode}/{contentCollectionId}/{lessonId}/cards/{cardId}')
	.onWrite(event => {
	    const contentCollectionId = event.params.contentCollectionId;

	    // Only proceed if the content collection is `lessons` or `classroom_resources`
	    if (contentCollectionId !== "lessons" && contentCollectionId !== "classroom_resources") {
	        return null;
        }

	    const attachmentPath = event.data.data().attachmentPath;

	    if (!attachmentPath) {
	        return null;
        }

		const bucket = functions.config().firebase.storageBucket;
		const file = gcs.bucket(bucket).file(attachmentPath);

		return file.getMetadata().then(function(data) {

			metadataObject = {
				"contentType": data[0]["contentType"],
				"size": Number(data[0]["size"]),
				"timeCreated": Date.parse(data[0]["timeCreated"])
			};

            return event.data.ref.update({
                attachmentMetadata: metadataObject
            });
		});
	});
