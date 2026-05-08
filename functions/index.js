const functions = require("firebase-functions"); // Force deploy
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

// Tu clave secreta de Stripe (la que empieza por sk_test_)
// Se configura con: firebase functions:config:set stripe.secret="sk_test_..."
const stripe = new Stripe(functions.config().stripe.secret);

// 1. Crear sesión de pago
exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Debes estar logueado.");
    }

    const { propertyId, roomId, checkIn, checkOut, nights, totalPrice } = data;

    // Obtener el providerId de la propiedad
    const propDoc = await db.collection('properties').doc(propertyId).get();
    const providerId = propDoc.exists ? (propDoc.data().providerId || propDoc.data().ownerId || 'unknown') : 'unknown';

    const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
            {
                price_data: {
                    currency: "eur",
                    product_data: {
                        name: "Reserva en Escápate",
                        description: `Check-in: ${checkIn}, Check-out: ${checkOut}`,
                    },
                    unit_amount: totalPrice * 100, // Stripe usa céntimos
                },
                quantity: 1,
            },
        ],
        mode: "payment",
        success_url: `https://diegopeonhernandez.github.io/motor-de-reservas/motor-reservas.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `https://diegopeonhernandez.github.io/motor-de-reservas/motor-reservas.html?cancelled=true`,
        metadata: {
            userId: context.auth.uid,
            propertyId,
            roomId,
            providerId,
            checkIn,
            checkOut,
            nights,
            totalPrice
        }
    });

    return { url: session.url };
});

// 2. Verificar pago y guardar reserva
exports.verifyAndSaveBooking = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Debes estar logueado.");
    }

    const { sessionId } = data;
    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        
        if (session.payment_status === "paid") {
            // Ya existe la reserva o la creamos
            const m = session.metadata;
            
            // Verificar si ya se guardó para no duplicar
            const existing = await db.collection("bookings").where("paymentSessionId", "==", sessionId).limit(1).get();
            if (!existing.empty) {
                return { success: true, message: "Reserva ya confirmada" };
            }

            // Guardar en Firestore
            await db.collection("bookings").add({
                propertyId: m.propertyId,
                roomId: m.roomId,
                userId: m.userId,
                providerId: m.providerId || "unknown", // Ajustar si es necesario
                checkIn: m.checkIn,
                checkOut: m.checkOut,
                nights: parseInt(m.nights),
                totalPrice: parseFloat(m.totalPrice),
                status: "confirmada",
                paymentStatus: "paid",
                paymentSessionId: sessionId,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            return { success: true };
        } else {
            throw new functions.https.HttpsError("failed-precondition", "El pago no se completó.");
        }
    } catch (error) {
        console.error("Error verifying payment:", error);
        throw new functions.https.HttpsError("internal", error.message);
    }
});
