import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as cors from 'cors';
import * as twilio from 'twilio';
import { Timestamp } from '@google-cloud/firestore';

const TWILIO_ACC_SID = "SID";
const TWILIO_ACC_TOKEN = "TOKEN";

let applycors = cors({ origin: true });
admin.initializeApp();

export const GetCarParkList = functions.https.onRequest((req, res) => {
    applycors(req, res, () => {
        var db = admin.firestore();
        db.collection("carparks").get().then(function (querySnapshot) {
            var objects = [];
            querySnapshot.forEach((doc) => {
                let data = doc.data();
                objects.push({
                    id: doc.id,
                    location: data.location,
                    name: data.name
                })
            })
            res.json({
                function: "GetCarParkList",
                data: objects
            })
        })
    });
});

export const CarParkFull = functions.https.onRequest((req, res) => {
    applycors(req, res, async () => {
        var carparkId = req.query.carpark;
        var db = admin.firestore();
        let promises = [];
        let availability = [];
        let querySnapshot = await db.collection("parkingspaces").where("carpark", "==", carparkId).get();
        if (querySnapshot.size == 0) {
            availability = [false];
            return;
        }
        for (let doc of querySnapshot.docs) {
            let available = true;
            if (doc.data().bookedUntil.seconds > Timestamp.now().seconds) {
                available = false;
            }
            if (available) {
                let qs = await db.collection("bookings").where("ParkingSpace", "==", doc.id).get();
                if (qs.size > 0) {
                    available = false;
                }
            }
            availability.push(available);
        }
        let availableCount = 0;
        availability.forEach((a) => {
            console.log(a);
            if (a == true) {
                availableCount += 1;
            }
        })
        let carParkFull = availableCount < 1;
        console.log(availableCount + " spaces available")
        res.json({
            function: "CarParkFull",
            data: {
                full: carParkFull,
                spaces: availableCount
            }
        })
    });
});

async function sendTestMessage(msgBody, phoneNumber) {
    if(phoneNumber[0] == " "){
        phoneNumber = phoneNumber.replace(" ", "+");
    }
    if (phoneNumber == "+441234567890") {
        console.log("Did not send to test number");
        return;
    }
    console.log("Sending message");
    let client = twilio(TWILIO_ACC_SID, TWILIO_ACC_TOKEN);
    await client.messages.create({
        body: msgBody,
        to: phoneNumber,
        from: "+15203143747"
    })
}

async function allocateSpace(db: FirebaseFirestore.Firestore, carparkid: string, userid: string, bookedUntil: Timestamp) {
    let spacesSnapshot = await db.collection("parkingspaces").where("carpark", "==", carparkid).where("bookedUntil", "<", Timestamp.now()).get();
    let space = spacesSnapshot.docs[0].ref;
    await space.update({
        "lastBooker": userid,
        "bookedUntil": bookedUntil
    })
    return space;
}

export const SendMessages = functions.pubsub.schedule("every 1 minutes").onRun(async (context) => {
    console.log("Sending messages....")
    var currentTime = Timestamp.now();
    let db = admin.firestore();
    let bookingsSnapshot = await db.collection("bookings").where("TimeStart", "<=", currentTime).get();
    await bookingsSnapshot.forEach(async function (booking) {
        let bookingData = booking.data();
        await booking.ref.delete();
        console.log("Deleted Booking " + booking.id);
        let space = await allocateSpace(db, bookingData.CarPark, bookingData.User, bookingData.TimeEnd);
        let spacesData = await space.get();
        let location = spacesData.data().location;
        await sendTestMessage(`Your parking space is ${location}`, bookingData.User);
    });

    let spacesSnapshot = await db.collection("parkingspaces").where("bookedUntil", "<", Timestamp.now()).get();
    spacesSnapshot.forEach(async (space) => {
        if (space.data().lastBooker == "") {
            return;
        }
        let carpark = await db.collection("carparks").doc(space.data().carpark).get();
        let carparkData = carpark.data();
        if (carparkData.SpacesLeft == undefined) {
            carparkData.SpacesLeft = 10;
        }
        carparkData.SpacesLeft += 1;
        await space.ref.update({
            lastBooker: ""
        })
        await carpark.ref.update(carparkData);
    });
});


export const createSpaces = functions.https.onRequest(async (req, res) => {
    let db = admin.firestore();
    // Delete the spaces collection
    let spacesSnapshot = await db.collection("parkingspaces").get();
    spacesSnapshot.forEach(async (space) => {
        await space.ref.delete();
    });

    let parksSnapshot = await db.collection("carparks").get();
    parksSnapshot.forEach(async (park) => {
        for (let i = 0; i < 50; i++) {
            await db.collection("parkingspaces").doc().set({
                bookedUntil: Timestamp.now(),
                carpark: park.id,
                lastBooker: "",
                location: "Floor " + i % 5
            })
        }
    });
    res.json({
        success: true
    })
})


export const MakeBooking = functions.https.onRequest(async (req, res) => {
    applycors(req, res, async () => {
        let db = admin.firestore();
        let failed = false;
        ["TimeStart", "Duration", "CarPark", "User"].forEach((s) => {
            if (!(s in req.query)) {
                failed = true;
                res.json({
                    success: false
                });
            }
        })
        if (failed) {
            return;
        }
        await db.collection("bookings").doc().set({
            TimeStart: new Timestamp(Number.parseInt(req.query.TimeStart), 0),
            TimeEnd: new Timestamp(Number.parseInt(req.query.TimeStart) + Number.parseInt(req.query.Duration), 0),
            CarPark: req.query.CarPark,
            User: req.query.User
        });
        console.log(req.query)
        let carParkDocRef = db.collection("carparks").doc(req.query.CarPark);
        let carParkDoc = await carParkDocRef.get();
        let carParkDocData = carParkDoc.data();
        if (carParkDocData.SpacesLeft === undefined) {
            carParkDocData.SpacesLeft = 10;
        }
        carParkDocData.SpacesLeft -= 1;
        await carParkDocRef.update(carParkDocData);
        res.json({
            success: true
        });
    });
});
