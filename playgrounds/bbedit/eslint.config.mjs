import stylistic from '@stylistic/eslint-plugin';

export default [{
	plugins: { '@stylistic': stylistic },
	rules: {
		'no-undef': 'error',
		'no-unused-vars': 'warn',
		'no-var': 'error',
		'prefer-const': 'error',
		'@stylistic/quotes': ['error', 'single'],
		'@stylistic/semi': ['error', 'always']
	}
}];
