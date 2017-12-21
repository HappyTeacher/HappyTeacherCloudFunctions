const functions = require('firebase-functions');
const admin = require('firebase-admin');
const gcs = require('@google-cloud/storage')();
admin.initializeApp(functions.config().firebase);

exports.createUserInFirestore = functions.auth.user().onCreate(event => {
    const user = event.data;
    const displayName = user.displayName;
    const email = user.email;
    const phoneNumber = user.phoneNumber;

    const userObject = {};

    if (displayName) {
        userObject["displayName"] = displayName;
    }

    if (email) {
        userObject["email"] = email;
    }

    if (phoneNumber) {
        userObject["phoneNumber"] = phoneNumber;
    }

    const firestore = admin.firestore();
    const usersCollection = firestore.collection("users");

    return usersCollection.doc(user.uid).set(userObject)
});

exports.deleteUserFromFirestore = functions.auth.user().onDelete(event => {
    const user = event.data;

    const firestore = admin.firestore();
    const usersCollection = firestore.collection("users");

    // TODO: Delete user's lessons and file attachments?

    return usersCollection.doc(user.uid).delete();
});

exports.onResourceCreate = functions.firestore.document('localized/{languageCode}/resources/{resourceId}')
    .onCreate(event => {
        const promises = [];

        const languageCode = event.params.languageCode;

        const resourceRef = event.data.ref;
        const resourceCollectionRef = event.data.ref.parent;
        const resource = event.data.data();

        if (resource.resourceType === "lesson" && resource.isFeatured && resource.status === "published") {
            promises.push(unfeatureOtherLessons(resource, resourceRef, resourceCollectionRef));
        } else if (resource.resourceType === "lesson") {
            promises.push(ensureSubtopicHasFeaturedLesson(resource.subtopic, resourceCollectionRef));
        }

        const updateTimestamp = updateResourceTimeUpdated(resourceRef);
        promises.push(updateTimestamp);

        const countSubmissions = countSubtopicLessonSubmissions(resource.subtopic, resourceCollectionRef);
        promises.push(countSubmissions);

        if (resource.resourceType === "lesson") {
            promises.push(associateSyllabusLessonsWithResource(resourceRef, resource.subtopic, languageCode))
        }

        return Promise.all(promises);
    });

exports.onResourceUpdate = functions.firestore.document('localized/{languageCode}/resources/{resourceId}')
    .onUpdate(event => {
        const promises = [];
        const resourceRef = event.data.ref;
        const resourceCollectionRef = event.data.ref.parent;
        const resource = event.data.data();
        const languageCode = event.params.languageCode;

        const isFeatured = resource.isFeatured;

        const oldStatus = event.data.previous.data()["status"];
        const newStatus = event.data.data()["status"];

        const oldSubtopic = event.data.previous.data()["subtopic"];
        const newSubtopic = event.data.data()["subtopic"];

        if (oldStatus && newStatus && oldStatus !== newStatus) {
            promises.push(onResourceStatusChange(resourceRef, newStatus, oldStatus, languageCode, resource));
            promises.push(countSubtopicLessonSubmissions(resource.subtopic, resourceCollectionRef));
        } else if (oldSubtopic && newSubtopic && oldSubtopic !== newSubtopic) {
            promises.push(countSubtopicLessonSubmissions(resource.subtopic, resourceCollectionRef));
        } else if (isFeatured) {
            promises.push(countSubtopicLessonSubmissions(resource.subtopic, resourceCollectionRef));
        }

        if (resource.resourceType === "lesson" && oldSubtopic && newSubtopic && oldSubtopic !== newSubtopic) {
            promises.push(associateSyllabusLessonsWithResource(resourceRef, newSubtopic, languageCode))
        }

        if (resource.resourceType === "lesson" && resource.isFeatured && newStatus === "published") {
            promises.push(unfeatureOtherLessons(resource, resourceRef, resourceCollectionRef))
        } else if (resource.resourceType === "lesson") {
            promises.push(ensureSubtopicHasFeaturedLesson(resource.subtopic, resourceCollectionRef));
        }

        return Promise.all(promises);
    });

exports.onCardCreate = functions.firestore.document('localized/{languageCode}/resources/{resourceId}/cards/{cardId}')
    .onCreate(event => {
        const resourceRef = event.data.ref.parent.parent;

        return updateResourceTimeUpdated(resourceRef);
});

exports.onCardUpdate = functions.firestore.document('localized/{languageCode}/resources/{resourceId}/cards/{cardId}')
    .onUpdate(event => {
        const promises = [];
        const resourceRef = event.data.ref.parent.parent;
        const cardRef = event.data.ref;

        const attachmentPath = event.data.data().attachmentPath;
        promises.push(addAttachmentMetadataToCard(cardRef, attachmentPath));

        promises.push(updateResourceTimeUpdated(resourceRef));

        return Promise.all(promises);
    });

exports.onUserUpdate = functions.firestore.document('users/{userId}')
    .onUpdate(event => {
        const userRef = event.data.ref;
        const user = event.data.data();
        const previousRole = event.data.previous.data().role;
        const role = user.role;
        const preferredLanguages = user["languages"];

        const promises = [];

        if (previousRole !== role && (role === "admin" || role === "moderator")) {
            promises.push(userRef.update({isAdminOrMod: true}))
        } else if (previousRole !== role && role !== "admin" && role !== "moderator") {
            promises.push(userRef.update({isAdminOrMod: false}))
        }

        if (preferredLanguages && (previousRole !== role)
            && (role === "admin" || role === "moderator")) {
            promises.push(subscribeReviewerToAllSubjectSubmissionNotifications(userRef, preferredLanguages));
        }

        return Promise.all(promises);
    });

function subscribeReviewerToAllSubjectSubmissionNotifications(userRef, preferredLanguages) {
    const promises = [];
    console.log(JSON.stringify(preferredLanguages));
    const languageCodes = Object.keys(preferredLanguages);

    languageCodes.forEach(function(languageCode) {
        promises.push(subscribeReviewerToAllSubjectSubmissionNotificationsForLanguage(languageCode, userRef))
    });

    return Promise.all(promises);
}

function subscribeReviewerToAllSubjectSubmissionNotificationsForLanguage(languageCode, userRef) {
    const promises = [];

    const firestore = admin.firestore();
    const subjectCollection = firestore.collection(`localized/${languageCode}/subjects`);
    const nonParentSubjectsQuery = subjectCollection.where("hasChildren", "==", false);

    return nonParentSubjectsQuery.get().then(function(querySnapshot) {
        querySnapshot.forEach(documentSnapshot => {
            const subjectName = documentSnapshot.data().name;
            promises.push(subscribeReviewerToSubmissionNotificationsForSubject(subjectName, userRef));
        });

        return Promise.all(promises);
    });
}

function subscribeReviewerToSubmissionNotificationsForSubject(subjectName, userRef) {
    return userRef.update(`watchingSubjects.${subjectName}`, true);
}

function countSubtopicLessonSubmissions(subtopic, resourceCollectionRef) {
    const lessonsForSubtopicQuery = resourceCollectionRef.where("subtopic", "==", subtopic)
        .where("resourceType", "==", "lesson")
        .where("status", "==", "published");

    return lessonsForSubtopicQuery.get().then(function(querySnapshot) {
        const count = querySnapshot.size;

        const featuredLessonsForSubtopicQuery = lessonsForSubtopicQuery.where("isFeatured", "==", true);

        const writePromises = [];
        featuredLessonsForSubtopicQuery.get().then(function(querySnapshot) {

            querySnapshot.forEach(function(doc) {
                let writePromise = doc.ref.update({subtopicSubmissionCount : count});
                writePromises.push(writePromise);
            });

            // Write count to all featured lessons (there should only be one)
            return Promise.all(writePromises);
        });
    });
}

/**
 * This function deletes card feedback and, when the parent resource still exists,
 *  it deletes card attachments from storage.
 *
 *  When the parent resource of a card is deleted, the cards will be deleted
 *  (by {@link onResourceDelete}) but the resource will not exist. In this case,
 *  we can't access the "authorId" field (since the parent resource is missing).
 *
 *  Thus, attachment deletion is also handled when an entire lesson is deleted
 *   in {@link onResourceDelete}.
 */
exports.onCardDelete = functions.firestore.document('localized/{languageCode}/resources/{resourceId}/cards/{cardId}')
    .onDelete(event => {
        const deletionPromises = [];

        const resourceId = event.params.resourceId;
        const cardId = event.params.cardId;

        const feedbackCollectionRef = event.data.ref.collection("feedback");
        const deleteFeedback = deleteAllDocuments(feedbackCollectionRef);

        deletionPromises.push(deleteFeedback);

        const resourceRef = event.data.ref.parent.parent;

        return resourceRef.get().then(function(documentSnapshot) {

            if (documentSnapshot.exists) {
                const authorId = documentSnapshot.data()["authorId"];
                deletionPromises.push(deleteAttachmentFilesForCard(authorId, resourceId, cardId));
            }

            return Promise.all(deletionPromises)
        });
    });

/**
 * Delete cards and their attachments when the parent resource is deleted.
 * {@see onCardDelete}
 */
exports.onResourceDelete = functions.firestore.document('localized/{languageCode}/resources/{resourceId}')
    .onDelete(event => {
        const resourceCollectionRef = event.data.ref.parent;
        const resourceRef = event.data.ref;
        const cardsRef = resourceRef.collection('cards');

        const authorId = event.data.previous.data().authorId;
        const resourceId = event.params.resourceId;
        const subtopic = event.data.previous.data()["subtopic"];

        const deletionPromises = [];

        deletionPromises.push(countSubtopicLessonSubmissions(subtopic, resourceCollectionRef));

        const deleteAllAttachments = deleteAllAttachmentFilesForResource(authorId, resourceId);
        deletionPromises.push(deleteAllAttachments);

        deletionPromises.push(deleteAllDocuments(cardsRef));

        return Promise.all(deletionPromises);
    });

/**
 * Count topics for syllabus lesson when a syllabus lesson changes.
 */
exports.onSyllabusLessonUpdate = functions.firestore.document('localized/{languageCode}/syllabus_lessons/{lessonId}')
    .onUpdate(event => {
        const lessonId = event.params.lessonId;
        const languageCode = event.params.languageCode;
        const firestoreRef = event.data.ref.firestore;

        return updateSyllabusLessonCount(lessonId, firestoreRef, languageCode);
    });

/**
 * Count topics for syllabus lesson when a topic changes.
 */
exports.onTopicWrite = functions.firestore.document('localized/{languageCode}/topics/{topicId}')
    .onWrite(event => {
        let oldSyllabusLessons = {};
        let newSyllabusLessons = {};

        if (event.data.previous && event.data.previous.data()["syllabus_lessons"]) {
            oldSyllabusLessons = event.data.previous.data()["syllabus_lessons"];
        }

        if (event.data.exists && event.data.data()["syllabus_lessons"]) {
            newSyllabusLessons = event.data.data()["syllabus_lessons"];
        }

        const languageCode = event.params.languageCode;
        const firestoreRef = event.data.ref.firestore;

        const writePromises = [];

        for (oldLessonId in oldSyllabusLessons) {
            writePromises.push(updateSyllabusLessonCount(oldLessonId, firestoreRef, languageCode))
        }

        for (newLessonId in newSyllabusLessons) {
            writePromises.push(updateSyllabusLessonCount(newLessonId, firestoreRef, languageCode))
        }

        return Promise.all(writePromises);
    });

exports.onSubtopicWrite = functions.firestore.document('localized/{languageCode}/subtopics/{subtopicId}')
    .onWrite(event => {
        const languageCode = event.params.languageCode;
        const subtopicId = event.params.subtopicId;
        const writePromises = [];

        writePromises.push(associateSyllabusLessonsWithResourcesForSubtopic(subtopicId, languageCode));

        return Promise.all(writePromises);
    });

function associateSyllabusLessonsWithResourcesForSubtopic(subtopicId, languageCode) {
    const firestore = admin.firestore();
    const resourcesCollection = firestore.collection(`localized/${languageCode}/resources`);

    const lessonsForSubtopicQuery = resourcesCollection.where("subtopic", "==", subtopicId)
        .where("resourceType", "==", "lesson");

    const promises = [];
    return lessonsForSubtopicQuery.get().then(function(querySnapshot) {
        querySnapshot.forEach(documentSnapshot => {
            const lessonRef = documentSnapshot.ref;
            promises.push(associateSyllabusLessonsWithResource(lessonRef, subtopicId, languageCode))
        });

        return Promise.all(promises)
    });
}

function associateSyllabusLessonsWithResource(resourceRef, subtopicId, languageCode) {
    const firestore = admin.firestore();
    const subtopicsCollection = firestore.collection(`localized/${languageCode}/subtopics`);
    const subtopicRef = subtopicsCollection.doc(subtopicId);

    subtopicRef.get().then(documentSnapshot => {
        if (documentSnapshot.exists) {
            const subtopic = documentSnapshot.data();
            const syllabusLessons = subtopic.syllabus_lessons;

            return resourceRef.update("syllabus_lessons", syllabusLessons)
        } else {
            return null;
        }
    });
}


function updateResourceTimeUpdated(resourceRef) {
    const now = new Date();

    return resourceRef.get().then(documentSnapshot => {
        if (documentSnapshot.exists) {
            const resourceData = documentSnapshot.data();
            const previousDateUpdated = resourceData.dateUpdated;

            if (previousDateUpdated) {
                // Calculate difference between the dates
                const timeDiffMillis = now - previousDateUpdated;
                const timeDiffMinutes = timeDiffMillis / 60000.0;

                // If the updated time is within 1 minute, don't update
                //  (this is to prevent this function from triggering too much)
                if (Math.abs(timeDiffMinutes) < 1) {
                    return null;
                }
            }

            return resourceRef.update({dateUpdated: now});
        }
    });
}

function ensureSubtopicHasFeaturedLesson(subtopic, collectionRef) {
    const featuredLessonsForSubtopicQuery = collectionRef.where("subtopic", "==", subtopic)
        .where("resourceType", "==", "lesson")
        .where("status", "==", "published")
        .where("isFeatured", "==", true);

    return featuredLessonsForSubtopicQuery.get().then(function(querySnapshot) {
        if (querySnapshot.empty) {
            // There are no featured lessons so feature the first one
            return featureFirstLessonForSubtopic(subtopic, collectionRef);
        } else {
            return null
        }
    });
}

function unfeatureOtherLessons(resource, resourceRef, collectionRef) {
    if (resource.resourceType !== "lesson" || resource.status !== "published") {
        return null;
    }

    const subtopic = resource.subtopic;

    const featuredLessonsForSubtopicQuery = collectionRef.where("subtopic", "==", subtopic)
        .where("resourceType", "==", "lesson")
        .where("status", "==", "published")
        .where("isFeatured", "==", true);

    return featuredLessonsForSubtopicQuery.get().then(function(querySnapshot) {
        const writePromises = [];

        // Unfeature any other featured lessons
        querySnapshot.forEach(function (doc) {

            if (doc.ref.path !== resourceRef.path) {
                let unfeaturePromise = doc.ref.update({isFeatured: false});
                writePromises.push(unfeaturePromise);
            }

        });

        return Promise.all(writePromises);
    });
}

function featureFirstLessonForSubtopic(subtopic, collectionRef) {
    const subtopicLessonsQuery = collectionRef.where("subtopic", "==", subtopic)
        .where("resourceType", "==", "lesson")
        .where("status", "==", "published");

    return subtopicLessonsQuery.get().then(function(querySnapshot) {
        if (querySnapshot.empty) {
            return null;
        } else {
            const firstLessonDoc = querySnapshot.docs[0];
            return firstLessonDoc.ref.update({isFeatured: true})
        }
    });
}

function addAttachmentMetadataToCard(cardRef, attachmentPath) {
    if (!attachmentPath) {
        return null;
    }

    const bucketName = functions.config().firebase.storageBucket;
    const file = gcs.bucket(bucketName).file(attachmentPath);

    return file.getMetadata().then(function(data) {

        metadataObject = {
            "contentType": data[0]["contentType"],
            "size": Number(data[0]["size"]),
            "timeCreated": Date.parse(data[0]["timeCreated"])
        };

        return cardRef.update({
            attachmentMetadata: metadataObject
        });
    });
}

function deleteAttachmentFilesForCard(userId, parentResourceId, cardId) {
    const bucketName = functions.config().firebase.storageBucket;
    const bucket = gcs.bucket(bucketName);

    const attachmentsDirectory = `user_uploads/${userId}/${parentResourceId}/${cardId}/`;

    return bucket.deleteFiles({ prefix: attachmentsDirectory });
}

function deleteAllAttachmentFilesForResource(userId, resourceId) {
    const bucketName = functions.config().firebase.storageBucket;
    const bucket = gcs.bucket(bucketName);

    const resourceAttachmentsDirectory = `user_uploads/${userId}/${resourceId}`;

    return bucket.deleteFiles({ prefix: resourceAttachmentsDirectory });
}

function deleteAllDocuments(collectionRef) {
    return collectionRef.get().then(querySnapshot => {
        const deletionPromises = [];

        querySnapshot.forEach(documentSnapshot => {
            deletionPromises.push(documentSnapshot.ref.delete());
        });

        return Promise.all(deletionPromises)
    });
}

function updateSyllabusLessonCount(lessonId, firestoreRef, languageCode) {
    const lessonRef = firestoreRef.collection(`localized/${languageCode}/syllabus_lessons`).doc(lessonId);

    const topicsForLessonQuery = firestoreRef.collection(`localized/${languageCode}/topics`)
        .where(`syllabus_lessons.${lessonId}`, "==", true);

    return topicsForLessonQuery.get().then(function(querySnapshot) {
        let count = querySnapshot.size;
        return lessonRef.update({topicCount: count})
    });
}

function onResourceStatusChange(resourceRef, newStatus, oldStatus, languageCode, resource) {
    const promises = [];
    const topicId = resource.topic;
    const subjectName = resource.subjectName;

    // Lock all feedback for each card
    promises.push(lockAllCardFeedbackForResource(resourceRef));

    // Create a convenience field so we can simulate performing a query
    // with logical OR -- we want to know if this lesson is either awaiting review or has
    // changes requested:
    const isAwaitingReview = newStatus === "awaiting review";
    const hasChangesRequested = newStatus === "changes requested";
    const isAwaitingReviewOrHasChangesRequested = isAwaitingReview || hasChangesRequested;
    const setOrField = resourceRef.update("isAwaitingReviewOrHasChangesRequested", isAwaitingReviewOrHasChangesRequested);

    promises.push(setOrField);

    if (newStatus === "awaiting review" || newStatus === "published") {
        // When submitting a lesson for review or publishing, clear feedback previews
        promises.push(clearFeedbackPreviewsForAllCardsInResource(resourceRef));
    }

    if (newStatus === "awaiting review") {
        // Alert reviewers who are watching this subject
        promises.push(notifyReviewersOfSubmission(languageCode, topicId))
    }

    if (oldStatus === "published") {
        // Unpublished resources aren't featured!
        promises.push(resourceRef.update({isFeatured: false}));
    }

    promises.push(notifyAuthorOfStatusChange(resourceRef, newStatus));
    promises.push(updateTopicPendingSubmissionFlag(topicId, languageCode));

    return Promise.all(promises);
}

function notifyReviewersOfSubmission(languageCode, topicId) {
    const firestore = admin.firestore();
    const topicsCollection = firestore.collection(`localized/${languageCode}/topics`);
    const subjectsCollection = firestore.collection(`localized/${languageCode}/subjects`);

    // Obtain subject through the topic..
    topicsCollection.doc(topicId).get().then(documentSnapshot => {
        if (documentSnapshot.exists) {
            const topic = documentSnapshot.data();
            const subjectId = topic.subject;

            return subjectsCollection.doc(subjectId).get().then(documentSnapshot => {
                if (documentSnapshot.exists) {
                    const subject = documentSnapshot.data();
                    return notifyReviewersOfSubmissionForSubject(subject, subjectId)
                } else {
                    return null;
                }
            });
        } else {
            return null;
        }
    });
}

function notifyReviewersOfSubmissionForSubject(subject, subjectId) {
    const firestore = admin.firestore();
    const usersCollection = firestore.collection("users");

    const subjectName = subject.name;
    const parentSubjectId = subject.parentSubject;

    const payload = {
        data: {
            subjectName: subject.name,
            subjectId: subjectId,
            parentSubjectId: parentSubjectId,
            notificationType: "newSubmissionForModerator"
        }
    };

    const reviewersWatchingSubjectQuery = usersCollection.where("isAdminOrMod", "==", true)
        .where(`watchingSubjects.${subjectName}`, "==", true);

    return reviewersWatchingSubjectQuery.get().then(function(querySnapshot) {
        const notificationTokens = [];

        querySnapshot.forEach(documentSnapshot => {
            const token = documentSnapshot.data()["registrationToken"];
            if (token) {
                notificationTokens.push(token)
            }

            return admin.messaging().sendToDevice(notificationTokens, payload);
        });
    });
}

function notifyAuthorOfStatusChange(resourceRef, newStatus) {
    if (newStatus === "published" || newStatus === "changes requested") {
        return resourceRef.get().then(documentSnapshot => {
            if (documentSnapshot.exists) {
                const data = documentSnapshot.data();
                const resourceName = data.name;
                const authorId = data.authorId;
                const resourceType = data.resourceType;

                const payload = {
                    data: {
                        status: newStatus,
                        referencePath: resourceRef.path,
                        resourceName: resourceName,
                        resourceType: resourceType,
                        notificationType: "statusChangeForAuthor"
                    }
                };

                return sendMessageToUserId(authorId, payload);

            } else {
                return null;
            }
        });

    } else {
        return null;
    }
}

/**
 * Get the registration token associated with the given user ID
 *  and send a Google Cloud Message with the given payload to
 *  that token.
 */
function sendMessageToUserId(userId, payload) {
    const firestore = admin.firestore();
    const usersCollection = firestore.collection("users");
    const userDocument = usersCollection.doc(userId);

    return userDocument.get().then(documentSnapshot => {
        if (documentSnapshot.exists) {
            const token = documentSnapshot.data().registrationToken;

            if (token) {
                return admin.messaging().sendToDevice(token, payload)
            } else {
                return null;
            }

        } else {
            return null;
        }
    });
}


function lockAllCardFeedbackForResource(resourceRef) {
    return resourceRef.collection("cards").get().then(querySnapshot => {
        const lockPromises = [];

        querySnapshot.forEach(documentSnapshot => {
            lockPromises.push(lockAllCardFeedback(documentSnapshot.ref));
        });

        return Promise.all(lockPromises);
    });

}

function lockAllCardFeedback(cardRef) {
    const feedbackCollectionRef = cardRef.collection("feedback");
    return feedbackCollectionRef.get().then(querySnapshot => {
        const lockPromises = [];
        querySnapshot.forEach(documentSnapshot => {
            lockPromises.push(setFeedbackToLocked(documentSnapshot.ref));
        });

        return Promise.all(lockPromises);
    });
}

function setFeedbackToLocked(feedbackRef) {
    return feedbackRef.update("locked", true);
}

function clearFeedbackPreviewsForAllCardsInResource(resourceRef) {
    return resourceRef.collection("cards").get().then(querySnapshot => {
        const clearPreviewPromises = [];

        querySnapshot.forEach(documentSnapshot => {
            clearPreviewPromises.push(clearFeedbackPreviewForCard(documentSnapshot.ref));
        });

        return Promise.all(clearPreviewPromises);
    });
}

function clearFeedbackPreviewForCard(cardRef) {
    const promises = [];
    promises.push(cardRef.update("feedbackPreviewComment", ""));
    promises.push(cardRef.update("feedbackPreviewCommentPath", ""));

    return Promise.all(promises);
}

// Mark whether a topic has pending submissions or not
function updateTopicPendingSubmissionFlag(topicId, languageCode) {
    const firestore = admin.firestore();
    const topicRef = firestore.doc(`localized/${languageCode}/topics/${topicId}`);

    const resourceCollection = firestore.collection(`localized/${languageCode}/resources`);
    const submissionQuery = resourceCollection.where("topic", "==", topicId)
                                .where("status", "==", "awaiting review");

    return submissionQuery.get().then(function(querySnapshot) {
        const topicHasSubmissions = !querySnapshot.empty;
        return topicRef.update({
            hasPendingSubmissions: topicHasSubmissions
        });
    });
}