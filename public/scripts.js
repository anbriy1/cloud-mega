const form = document.getElementById('loginForm');

form.addEventListener('submit', function (event) {
    event.preventDefault();

    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    // Send credentials to server to get a token
    fetch('/api/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, password })
    })
    .then(async (res) => {
        const contentType = res.headers.get('content-type') || '';
        const data = contentType.includes('application/json') ? await res.json() : {};
        if (!res.ok) {
            const msg = data && data.error ? data.error : 'Login failed';
            throw new Error(msg);
        }
        return data;
    })
    .then((data) => {
        // Save token and email for index.html
        localStorage.setItem('auth_token', data.token);
        localStorage.setItem('auth_email', data.email || email);
        // Redirect to app
        window.location.href = '/index.html';
    })
    .catch((err) => {
        alert('Authentication error: ' + err.message);
    });

});