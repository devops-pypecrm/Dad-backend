import Joi from 'joi';
import { Request, Response, NextFunction } from 'express';

// Phone number validation regex (international format)
const phoneRegex = /^\+[1-9]\d{1,14}$/;

// WhatsApp message validation schemas
export const whatsappMessageSchema = Joi.object({
    to: Joi.string().pattern(phoneRegex).required().messages({
        'string.pattern.base': 'Phone number must be in international format (+1234567890)',
        'any.required': 'Phone number (to) is required'
    }),
    message: Joi.when('type', {
        is: 'text',
        then: Joi.string().max(4096).required().messages({
            'string.max': 'Message cannot exceed 4096 characters (WhatsApp limit)',
            'any.required': 'Message text is required for text messages'
        }),
        otherwise: Joi.string().optional()
    }),
    type: Joi.string().valid('text', 'template').default('text'),
    templateName: Joi.when('type', {
        is: 'template',
        then: Joi.string().required().messages({
            'any.required': 'Template name is required for template messages'
        }),
        otherwise: Joi.string().optional()
    }),
    languageCode: Joi.string().default('en_US'),
    components: Joi.array().items(Joi.object()).default([])
});

// WhatsApp campaign validation schema
export const whatsappCampaignSchema = Joi.object({
    name: Joi.string().min(1).max(255).required().messages({
        'string.min': 'Campaign name cannot be empty',
        'string.max': 'Campaign name cannot exceed 255 characters',
        'any.required': 'Campaign name is required'
    }),
    message: Joi.string().min(1).max(4096).required().messages({
        'string.min': 'Campaign message cannot be empty',
        'string.max': 'Campaign message cannot exceed 4096 characters',
        'any.required': 'Campaign message is required'
    }),
    templateId: Joi.string().optional(),
    status: Joi.string().valid('draft', 'scheduled', 'sent').default('draft'),
    scheduledAt: Joi.date().greater('now').optional().messages({
        'date.greater': 'Scheduled time must be in the future'
    }),
    recipients: Joi.array().items(
        Joi.object({
            type: Joi.string().valid('lead', 'contact', 'phone').required(),
            id: Joi.string().when('type', {
                is: Joi.valid('lead', 'contact'),
                then: Joi.required(),
                otherwise: Joi.optional()
            }),
            phone: Joi.string().pattern(phoneRegex).when('type', {
                is: 'phone',
                then: Joi.required(),
                otherwise: Joi.optional()
            }),
            name: Joi.string().optional()
        })
    ).min(1).optional().messages({
        'array.min': 'At least one recipient is required'
    }),
    testNumber: Joi.string().pattern(phoneRegex).optional()
});

// Meta integration validation schema
export const metaIntegrationSchema = Joi.object({
    connected: Joi.boolean().required(),
    pageId: Joi.when('connected', {
        is: true,
        then: Joi.string().required().messages({
            'any.required': 'Page ID is required when connected'
        }),
        otherwise: Joi.string().optional()
    }),
    accessToken: Joi.when('connected', {
        is: true,
        then: Joi.string().required().messages({
            'any.required': 'Access token is required when connected'
        }),
        otherwise: Joi.string().optional()
    }),
    adAccountId: Joi.when('connected', {
        is: true,
        then: Joi.string().pattern(/^act_\d+$/).required().messages({
            'string.pattern.base': 'Ad Account ID must start with "act_" followed by numbers',
            'any.required': 'Ad Account ID is required when connected'
        }),
        otherwise: Joi.string().optional()
    })
});

// WhatsApp integration validation schema
export const whatsappIntegrationSchema = Joi.object({
    connected: Joi.boolean().required(),
    accessToken: Joi.when('connected', {
        is: true,
        then: Joi.string().required().messages({
            'any.required': 'Access token is required when connected'
        }),
        otherwise: Joi.string().optional()
    }),
    phoneNumberId: Joi.when('connected', {
        is: true,
        then: Joi.string().required().messages({
            'any.required': 'Phone Number ID is required when connected'
        }),
        otherwise: Joi.string().optional()
    }),
    wabaId: Joi.string().optional(),
    appId: Joi.string().optional(),
    appSecret: Joi.string().optional()
});

// WhatsApp media message validation schema
export const whatsappMediaMessageSchema = Joi.object({
    to: Joi.string().pattern(phoneRegex).required().messages({
        'string.pattern.base': 'Phone number must be in international format (+1234567890)',
        'any.required': 'Phone number (to) is required'
    }),
    mediaType: Joi.string().valid('image', 'document', 'audio', 'video').required().messages({
        'any.required': 'Media type is required',
        'any.only': 'Media type must be one of: image, document, audio, video'
    }),
    mediaId: Joi.string().required().messages({
        'any.required': 'Media ID is required'
    }),
    caption: Joi.string().max(1024).optional().messages({
        'string.max': 'Caption cannot exceed 1024 characters'
    }),
    filename: Joi.string().max(255).optional().messages({
        'string.max': 'Filename cannot exceed 255 characters'
    })
});

// WhatsApp template creation validation schema
export const whatsappTemplateSchema = Joi.object({
    name: Joi.string().min(1).max(512).pattern(/^[a-z0-9_]+$/).required().messages({
        'string.min': 'Template name cannot be empty',
        'string.max': 'Template name cannot exceed 512 characters',
        'string.pattern.base': 'Template name can only contain lowercase letters, numbers, and underscores',
        'any.required': 'Template name is required'
    }),
    category: Joi.string().valid('AUTHENTICATION', 'MARKETING', 'UTILITY').required().messages({
        'any.required': 'Template category is required',
        'any.only': 'Category must be one of: AUTHENTICATION, MARKETING, UTILITY'
    }),
    language: Joi.string().default('en_US'),
    components: Joi.array().items(
        Joi.object({
            type: Joi.string().valid('HEADER', 'BODY', 'FOOTER', 'BUTTONS').required(),
            format: Joi.string().when('type', {
                is: 'HEADER',
                then: Joi.valid('TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT').optional(),
                otherwise: Joi.forbidden()
            }),
            text: Joi.string().when('type', {
                is: Joi.valid('HEADER', 'BODY', 'FOOTER'),
                then: Joi.string().max(1024).optional(),
                otherwise: Joi.forbidden()
            }),
            // Meta rejects templates with {{n}} variables unless sample values are supplied
            example: Joi.object().when('type', {
                is: Joi.valid('HEADER', 'BODY'),
                then: Joi.object().optional(),
                otherwise: Joi.forbidden()
            }),
            buttons: Joi.array().when('type', {
                is: 'BUTTONS',
                then: Joi.array().items(
                    Joi.object({
                        type: Joi.string().valid('QUICK_REPLY', 'URL', 'PHONE_NUMBER').required(),
                        text: Joi.string().max(25).required(),
                        url: Joi.string().when('type', {
                            is: 'URL',
                            then: Joi.required(),
                            otherwise: Joi.forbidden()
                        }),
                        example: Joi.array().items(Joi.string()).optional(),
                        phone_number: Joi.string().when('type', {
                            is: 'PHONE_NUMBER',
                            then: Joi.required(),
                            otherwise: Joi.forbidden()
                        })
                    })
                ).max(3),
                otherwise: Joi.forbidden()
            })
        })
    ).required().messages({
        'any.required': 'Template components are required'
    })
});

// Mark message as read validation schema
export const markReadSchema = Joi.object({
    messageId: Joi.string().required().messages({
        'any.required': 'Message ID is required'
    })
});

// Mark conversation as read validation schema
export const markConversationReadSchema = Joi.object({
    phoneNumber: Joi.string().pattern(phoneRegex).required().messages({
        'string.pattern.base': 'Phone number must be in international format (+1234567890)',
        'any.required': 'Phone number is required'
    })
});

// Generic validation middleware
export const validate = (schema: Joi.ObjectSchema) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const { error, value } = schema.validate(req.body, {
            abortEarly: false,
            stripUnknown: true
        });

        if (error) {
            const errors = error.details.map((detail: Joi.ValidationErrorItem) => ({
                field: detail.path.join('.'),
                message: detail.message
            }));

            return res.status(400).json({
                error: 'Validation failed',
                details: errors
            });
        }

        // Replace req.body with validated and sanitized data
        req.body = value;
        next();
    };
};

// Phone number validation utility
export const validatePhoneNumber = (phone: string): boolean => {
    return phoneRegex.test(phone);
};

// Sanitize input to prevent XSS
export const sanitizeInput = (input: string): string => {
    if (typeof input !== 'string') return input;

    return input
        .replace(/[<>]/g, '') // Remove potential HTML tags
        .trim() // Remove leading/trailing whitespace
        .substring(0, 10000); // Limit length to prevent DoS
};