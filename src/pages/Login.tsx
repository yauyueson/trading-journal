import React, { useState } from 'react';
import { supabase } from '../lib/supabase';

interface LoginPageProps {
    onLogin: () => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setLoading(true);

        const { error: authError } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        setLoading(false);

        if (authError) {
            setError(authError.message);
        } else {
            onLogin();
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-bg-primary">
            <div className="w-full max-w-sm fade-in">
                <div className="text-center mb-8">
                    <h1 className="text-3xl font-bold mb-2">Trading Journal</h1>
                    <p className="text-text-secondary">Track your options with discipline</p>
                </div>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <input
                        type="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        placeholder="Email"
                        className="w-full px-4 py-4 rounded-xl text-lg"
                        autoFocus
                        required
                    />
                    <input
                        type="password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="Password"
                        className="w-full px-4 py-4 rounded-xl text-lg"
                        required
                    />
                    {error && <p className="text-accent-red text-sm text-center">{error}</p>}
                    <button
                        type="submit"
                        className="btn-primary w-full py-4 rounded-xl text-lg"
                        disabled={loading}
                    >
                        {loading ? 'Signing in...' : 'Continue'}
                    </button>
                </form>
            </div>
        </div>
    );
};
