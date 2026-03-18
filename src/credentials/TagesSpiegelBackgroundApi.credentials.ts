import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class TagesSpiegelBackgroundApi implements ICredentialType {
  name = 'tagesSpiegelBackgroundApi';
  displayName = 'Tagesspiegel Background API';
  documentationUrl = 'https://background.tagesspiegel.de';
  properties: INodeProperties[] = [
    {
      displayName: 'Email',
      name: 'email',
      type: 'string',
      typeOptions: {
        password: false,
      },
      default: '',
      placeholder: 'your@email.com',
    },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      typeOptions: {
        password: true,
      },
      default: '',
    },
  ];
}
