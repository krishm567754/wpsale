<?php
// Simple Whitelist Manager for Shri Laxmi Auto Store
$firebase_url = "YOUR_FIREBASE_DATABASE_URL/allowed_users.json";

if ($_SERVER['REQUEST_METHOD'] == 'POST') {
    $number = $_POST['number'];
    // Logic to add number to Firebase via cURL
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, "YOUR_FIREBASE_DATABASE_URL/allowed_users/$number.json");
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, "PUT");
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(["status" => "active"]));
    curl_exec($ch);
    curl_close($ch);
    echo "Number $number added successfully!";
}
?>
<form method="POST">
    <h3>Manage Bot Access</h3>
    <input type="text" name="number" placeholder="919783828401" required>
    <button type="submit">Authorize Number</button>
</form>
